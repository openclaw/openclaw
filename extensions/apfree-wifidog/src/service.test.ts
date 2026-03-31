import { once } from "node:events";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { resolveApFreeWifidogConfig } from "./config.js";
import { ApFreeWifidogBridge } from "./manager.js";

function createLogger() {
  return {
    info() {},
    warn() {},
    error() {},
    debug() {},
  };
}

const bridges: ApFreeWifidogBridge[] = [];

async function getFreePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("failed to allocate test port");
  }
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

afterEach(async () => {
  while (bridges.length > 0) {
    const bridge = bridges.pop();
    if (bridge) {
      await bridge.stop();
    }
  }
});

describe("ApFreeWifidogBridge", () => {
  it("tracks device connect and resolves req_id-correlated responses", async () => {
    const bridge = new ApFreeWifidogBridge({
      config: resolveApFreeWifidogConfig({
        enabled: true,
        bind: "127.0.0.1",
        port: 19190,
        path: "/ws/wifidogx",
        requestTimeoutMs: 5000,
      }),
      logger: createLogger(),
    });
    bridges.push(bridge);
    await bridge.start();

    const ws = new WebSocket("ws://127.0.0.1:19190/ws/wifidogx");
    await once(ws, "open");
    ws.send(
      JSON.stringify({
        op: "connect",
        device_id: "dev-1",
        device_info: { ap_device_id: "ap-1" },
        gateway: [{ gw_id: "gw-1" }],
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    const devices = bridge.listDevices();
    expect(devices).toHaveLength(1);
    expect(devices[0]?.deviceId).toBe("dev-1");

    const responsePromise = bridge.callDevice({
      deviceId: "dev-1",
      op: "get_status",
    });

    const [messageEvent] = (await once(ws, "message")) as [Buffer];
    const outbound = JSON.parse(messageEvent.toString("utf8")) as Record<string, unknown>;
    expect(outbound.op).toBe("get_status");
    expect(outbound.device_id).toBe("dev-1");
    expect(typeof outbound.req_id).toBe("string");
    expect(outbound.req_id as string).toMatch(/^[0-9a-f]{16}$/);

    ws.send(
      JSON.stringify({
        op: "get_status_response",
        req_id: outbound.req_id,
        data: { service: "apfree-wifidog" },
      }),
    );

    const response = await responsePromise;
    expect(response.op).toBe("get_status_response");
    expect(response.data).toEqual({ service: "apfree-wifidog" });

    ws.close();
    await once(ws, "close");
  });

  it("redacts sensitive connect payload fields before AWAS debug logging", async () => {
    const debug = vi.fn();
    const bridge = new ApFreeWifidogBridge({
      config: resolveApFreeWifidogConfig({
        enabled: true,
        bind: "127.0.0.1",
        port: 19214,
        path: "/ws/wifidogx",
        requestTimeoutMs: 5000,
        awasEnabled: true,
      }),
      logger: {
        ...createLogger(),
        debug,
      },
    });
    bridges.push(bridge);
    await bridge.start();

    const ws = new WebSocket("ws://127.0.0.1:19214/ws/wifidogx");
    await once(ws, "open");
    ws.send(
      JSON.stringify({
        op: "connect",
        device_id: "dev-redact",
        token: "secret-token",
        command: "sensitive-command",
        gateway: [{ gw_id: "gw-1" }],
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 50));

    const forwardLog = debug.mock.calls
      .map(([message]) => String(message))
      .find((message) => message.includes("forwarding message to AWAS for device=dev-redact"));

    expect(forwardLog).toBeTruthy();
    expect(forwardLog).toContain('"token":"[REDACTED]"');
    expect(forwardLog).toContain('"command":"[REDACTED]"');
    expect(forwardLog).not.toContain("secret-token");
    expect(forwardLog).not.toContain("sensitive-command");

    ws.close();
    await once(ws, "close");
  });

  it("does not create AWAS proxy or forward connect in non-cloud mode", async () => {
    const bridge = new ApFreeWifidogBridge({
      config: resolveApFreeWifidogConfig({
        enabled: true,
        bind: "127.0.0.1",
        port: 19224,
        path: "/ws/wifidogx",
        requestTimeoutMs: 5000,
        awasEnabled: true,
      }),
      logger: createLogger(),
    });
    bridges.push(bridge);
    await bridge.start();

    const ensureProxy = vi.fn();
    const forwardToAwas = vi.fn();
    (
      bridge as unknown as {
        awasProxy: { ensureProxy: typeof ensureProxy; forwardToAwas: typeof forwardToAwas };
      }
    ).awasProxy.ensureProxy = ensureProxy;
    (
      bridge as unknown as {
        awasProxy: { ensureProxy: typeof ensureProxy; forwardToAwas: typeof forwardToAwas };
      }
    ).awasProxy.forwardToAwas = forwardToAwas;

    const ws = new WebSocket("ws://127.0.0.1:19224/ws/wifidogx");
    await once(ws, "open");
    ws.send(
      JSON.stringify({
        op: "connect",
        device_id: "dev-non-cloud",
        mode: 1,
        gateway: [],
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(ensureProxy).not.toHaveBeenCalled();
    expect(forwardToAwas).not.toHaveBeenCalled();

    ws.close();
    await once(ws, "close");
  });

  it("accepts new websocket upgrades after bridge restart", async () => {
    const bridge = new ApFreeWifidogBridge({
      config: resolveApFreeWifidogConfig({
        enabled: true,
        bind: "127.0.0.1",
        port: 19215,
        path: "/ws/wifidogx",
        requestTimeoutMs: 5000,
      }),
      logger: createLogger(),
    });
    bridges.push(bridge);
    await bridge.start();

    const wsBeforeRestart = new WebSocket("ws://127.0.0.1:19215/ws/wifidogx");
    await once(wsBeforeRestart, "open");
    wsBeforeRestart.send(JSON.stringify({ op: "connect", device_id: "dev-before", gateway: [] }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bridge.getDevice("dev-before")?.deviceId).toBe("dev-before");

    await bridge.stop();

    const index = bridges.indexOf(bridge);
    if (index >= 0) {
      bridges.splice(index, 1);
    }

    await bridge.start();
    bridges.push(bridge);

    const wsAfterRestart = new WebSocket("ws://127.0.0.1:19215/ws/wifidogx");
    await once(wsAfterRestart, "open");
    wsAfterRestart.send(JSON.stringify({ op: "connect", device_id: "dev-after", gateway: [] }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(bridge.getDevice("dev-after")?.deviceId).toBe("dev-after");

    wsAfterRestart.close();
    await once(wsAfterRestart, "close");
  });

  it("rejects malformed websocket upgrade targets with 400 and keeps listener alive", async () => {
    const bridge = new ApFreeWifidogBridge({
      config: resolveApFreeWifidogConfig({
        enabled: true,
        bind: "127.0.0.1",
        port: 19216,
        path: "/ws/wifidogx",
        requestTimeoutMs: 5000,
      }),
      logger: createLogger(),
    });
    bridges.push(bridge);
    await bridge.start();

    const malformedResponse = await new Promise<string>((resolve, reject) => {
      const socket = net.createConnection({ host: "127.0.0.1", port: 19216 }, () => {
        socket.write(
          "GET // HTTP/1.1\r\n" +
            "Host: 127.0.0.1:19216\r\n" +
            "Connection: Upgrade\r\n" +
            "Upgrade: websocket\r\n" +
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
            "Sec-WebSocket-Version: 13\r\n" +
            "\r\n",
        );
      });

      let response = "";
      socket.on("data", (chunk) => {
        response += chunk.toString("utf8");
        if (response.includes("\r\n\r\n")) {
          socket.end();
        }
      });
      socket.on("end", () => resolve(response));
      socket.on("error", reject);
    });

    expect(malformedResponse.startsWith("HTTP/1.1 400 Bad Request")).toBe(true);

    const ws = new WebSocket("ws://127.0.0.1:19216/ws/wifidogx");
    await once(ws, "open");
    ws.send(JSON.stringify({ op: "connect", device_id: "dev-malformed-path", gateway: [] }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bridge.getDevice("dev-malformed-path")?.deviceId).toBe("dev-malformed-path");

    ws.close();
    await once(ws, "close");
  });

  it("uses random hex string req_ids and avoids AWAS pending collisions", async () => {
    const bridge = new ApFreeWifidogBridge({
      config: resolveApFreeWifidogConfig({
        enabled: true,
        bind: "127.0.0.1",
        port: 19213,
        path: "/ws/wifidogx",
        requestTimeoutMs: 3000,
      }),
      logger: createLogger(),
    });
    bridges.push(bridge);
    await bridge.start();

    const ws = new WebSocket("ws://127.0.0.1:19213/ws/wifidogx");
    await once(ws, "open");
    ws.send(JSON.stringify({ op: "connect", device_id: "dev-skip", gateway: [] }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const responsePromise = bridge.callDevice({
      deviceId: "dev-skip",
      op: "get_status",
    });

    const [messageEvent] = (await once(ws, "message")) as [Buffer];
    const outbound = JSON.parse(messageEvent.toString("utf8")) as Record<string, unknown>;
    // req_id must be a 16-character lowercase hex string
    expect(typeof outbound.req_id).toBe("string");
    expect(outbound.req_id as string).toMatch(/^[0-9a-f]{16}$/);

    ws.send(
      JSON.stringify({
        op: "get_status_response",
        req_id: outbound.req_id,
        data: { service: "skip-ok" },
      }),
    );

    await responsePromise;
    ws.terminate();
  });

  it("removes stale device aliases when a device disconnects", async () => {
    const bridge = new ApFreeWifidogBridge({
      config: resolveApFreeWifidogConfig({
        enabled: true,
        bind: "127.0.0.1",
        port: 19212,
        path: "/ws/wifidogx",
        requestTimeoutMs: 3000,
      }),
      logger: createLogger(),
    });
    bridges.push(bridge);
    await bridge.start();

    const ws = new WebSocket("ws://127.0.0.1:19212/ws/wifidogx");
    await once(ws, "open");
    ws.send(JSON.stringify({ op: "connect", device_id: "dev-alias", gateway: [] }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(bridge.listDevices()[0]?.alias).toBe("Router-1");

    ws.close();
    await once(ws, "close");

    expect(
      (
        bridge as unknown as {
          deviceAliases: Map<string, string>;
        }
      ).deviceAliases.has("dev-alias"),
    ).toBe(false);
  });

  it("skips aliases that collide with a connected device ID", async () => {
    const bridge = new ApFreeWifidogBridge({
      config: resolveApFreeWifidogConfig({
        enabled: true,
        bind: "127.0.0.1",
        port: 19217,
        path: "/ws/wifidogx",
        requestTimeoutMs: 3000,
      }),
      logger: createLogger(),
    });
    bridges.push(bridge);
    await bridge.start();

    const wsRealId = new WebSocket("ws://127.0.0.1:19217/ws/wifidogx");
    await once(wsRealId, "open");
    wsRealId.send(JSON.stringify({ op: "connect", device_id: "Router-1", gateway: [] }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const wsAlias = new WebSocket("ws://127.0.0.1:19217/ws/wifidogx");
    await once(wsAlias, "open");
    wsAlias.send(JSON.stringify({ op: "connect", device_id: "dev-alias-safe", gateway: [] }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(bridge.getDevice("Router-1")?.deviceId).toBe("Router-1");
    expect(bridge.getDevice("Router-2")?.deviceId).toBe("dev-alias-safe");
    expect(bridge.listDevices().find((entry) => entry.deviceId === "dev-alias-safe")?.alias).toBe(
      "Router-2",
    );

    wsAlias.close();
    await once(wsAlias, "close");
    wsRealId.close();
    await once(wsRealId, "close");
  });

  it("reassigns an existing alias when a router connects using that device ID", async () => {
    const bridge = new ApFreeWifidogBridge({
      config: resolveApFreeWifidogConfig({
        enabled: true,
        bind: "127.0.0.1",
        port: 19218,
        path: "/ws/wifidogx",
        requestTimeoutMs: 3000,
      }),
      logger: createLogger(),
    });
    bridges.push(bridge);
    await bridge.start();

    const wsAlias = new WebSocket("ws://127.0.0.1:19218/ws/wifidogx");
    await once(wsAlias, "open");
    wsAlias.send(JSON.stringify({ op: "connect", device_id: "dev-first", gateway: [] }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bridge.getDevice("Router-1")?.deviceId).toBe("dev-first");

    const wsRealId = new WebSocket("ws://127.0.0.1:19218/ws/wifidogx");
    await once(wsRealId, "open");
    wsRealId.send(JSON.stringify({ op: "connect", device_id: "Router-1", gateway: [] }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(bridge.getDevice("Router-1")?.deviceId).toBe("Router-1");
    expect(bridge.getDevice("Router-2")?.deviceId).toBe("dev-first");
    expect(bridge.listDevices().find((entry) => entry.deviceId === "dev-first")?.alias).toBe(
      "Router-2",
    );

    wsRealId.close();
    await once(wsRealId, "close");
    wsAlias.close();
    await once(wsAlias, "close");
  });

  it("clears device aliases when the bridge stops", async () => {
    const bridge = new ApFreeWifidogBridge({
      config: resolveApFreeWifidogConfig({
        enabled: true,
        bind: "127.0.0.1",
        port: 19216,
        path: "/ws/wifidogx",
        requestTimeoutMs: 3000,
      }),
      logger: createLogger(),
    });
    bridges.push(bridge);
    await bridge.start();

    const ws = new WebSocket("ws://127.0.0.1:19216/ws/wifidogx");
    await once(ws, "open");
    ws.send(JSON.stringify({ op: "connect", device_id: "dev-stop-alias", gateway: [] }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(bridge.getDevice("Router-1")?.deviceId).toBe("dev-stop-alias");

    await bridge.stop();

    const index = bridges.indexOf(bridge);
    if (index >= 0) {
      bridges.splice(index, 1);
    }

    expect(bridge.getDevice("Router-1")).toBeNull();
    expect(
      (
        bridge as unknown as {
          deviceAliases: Map<string, string>;
        }
      ).deviceAliases.size,
    ).toBe(0);
  });

  it("clears a prior device binding before remapping the same socket", async () => {
    const bridge = new ApFreeWifidogBridge({
      config: resolveApFreeWifidogConfig({
        enabled: true,
        bind: "127.0.0.1",
        port: 19209,
        path: "/ws/wifidogx",
        requestTimeoutMs: 3000,
      }),
      logger: createLogger(),
    });
    bridges.push(bridge);
    await bridge.start();

    const ws = new WebSocket("ws://127.0.0.1:19209/ws/wifidogx");
    await once(ws, "open");

    ws.send(JSON.stringify({ op: "connect", device_id: "dev-old", gateway: [] }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    ws.send(JSON.stringify({ op: "heartbeat", device_id: "dev-new", gateway: [] }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const devices = bridge.listDevices();
    expect(devices.map((entry) => entry.deviceId)).toEqual(["dev-new"]);
    expect(bridge.getDevice("dev-old")).toBeNull();

    await expect(
      bridge.callDevice({
        deviceId: "dev-old",
        op: "get_status",
      }),
    ).rejects.toThrow("device offline or not found: dev-old");

    ws.terminate();
  });

  it("preserves prior gateway and device info on minimal heartbeat updates", async () => {
    const bridge = new ApFreeWifidogBridge({
      config: resolveApFreeWifidogConfig({
        enabled: true,
        bind: "127.0.0.1",
        port: 19217,
        path: "/ws/wifidogx",
        requestTimeoutMs: 3000,
      }),
      logger: createLogger(),
    });
    bridges.push(bridge);
    await bridge.start();

    const ws = new WebSocket("ws://127.0.0.1:19217/ws/wifidogx");
    await once(ws, "open");

    ws.send(
      JSON.stringify({
        op: "connect",
        device_id: "dev-preserve",
        device_info: { ap_device_id: "ap-1" },
        gateway: [{ gw_id: "gw-1" }],
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    ws.send(
      JSON.stringify({
        op: "heartbeat",
        device_id: "dev-preserve",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(bridge.getDevice("dev-preserve")).toMatchObject({
      deviceId: "dev-preserve",
      deviceInfo: { ap_device_id: "ap-1" },
      gateway: [{ gw_id: "gw-1" }],
    });

    ws.terminate();
  });

  it("resolves one-way operations without waiting for a response", async () => {
    const bridge = new ApFreeWifidogBridge({
      config: resolveApFreeWifidogConfig({
        enabled: true,
        bind: "127.0.0.1",
        port: 19191,
        path: "/ws/wifidogx",
      }),
      logger: createLogger(),
    });
    bridges.push(bridge);
    await bridge.start();

    const ws = new WebSocket("ws://127.0.0.1:19191/ws/wifidogx");
    await once(ws, "open");
    ws.send(JSON.stringify({ op: "connect", device_id: "dev-2", gateway: [] }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const responsePromise = bridge.callDevice({
      deviceId: "dev-2",
      op: "auth",
      payload: {
        client_ip: "192.168.1.10",
        client_mac: "AA:BB:CC:DD:EE:FF",
        token: "token-1",
        gw_id: "gw-1",
      },
    });

    const [messageEvent] = (await once(ws, "message")) as [Buffer];
    const outbound = JSON.parse(messageEvent.toString("utf8")) as Record<string, unknown>;
    expect(outbound.op).toBe("auth");

    const response = await responsePromise;
    expect(response.status).toBe("sent");
    expect(response.type).toBe("auth");

    ws.close();
    await once(ws, "close");
  });

  it("logs pending diagnostics when a request times out", async () => {
    const warn = vi.fn();
    const bridge = new ApFreeWifidogBridge({
      config: resolveApFreeWifidogConfig({
        enabled: true,
        bind: "127.0.0.1",
        port: 19219,
        path: "/ws/wifidogx",
        requestTimeoutMs: 1000,
      }),
      logger: {
        ...createLogger(),
        warn,
      },
    });
    bridges.push(bridge);
    await bridge.start();

    const ws = new WebSocket("ws://127.0.0.1:19219/ws/wifidogx");
    await once(ws, "open");
    ws.send(JSON.stringify({ op: "connect", device_id: "dev-timeout", gateway: [] }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    await expect(
      bridge.callDevice({
        deviceId: "dev-timeout",
        op: "get_wifi_info",
      }),
    ).rejects.toThrow("request timeout: get_wifi_info");

    const timeoutLog = warn.mock.calls
      .map(([message]) => String(message))
      .find((message) => message.includes("request timeout device=dev-timeout op=get_wifi_info"));

    expect(timeoutLog).toBeTruthy();
    expect(timeoutLog).toContain("pending_device_count=");
    expect(timeoutLog).toContain("pending_preview=");
    expect(timeoutLog).toContain("age_ms=");

    ws.terminate();
  });

  it("normalizes envelope responses and rejects envelope data.type *_error", async () => {
    const bridge = new ApFreeWifidogBridge({
      config: resolveApFreeWifidogConfig({
        enabled: true,
        bind: "127.0.0.1",
        port: 19192,
        path: "/ws/wifidogx",
        requestTimeoutMs: 3000,
      }),
      logger: createLogger(),
    });
    bridges.push(bridge);
    await bridge.start();

    const ws = new WebSocket("ws://127.0.0.1:19192/ws/wifidogx");
    await once(ws, "open");
    ws.send(JSON.stringify({ op: "connect", device_id: "dev-3", gateway: [] }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const successPromise = bridge.callDevice({
      deviceId: "dev-3",
      op: "get_clients",
    });

    const [successEvent] = (await once(ws, "message")) as [Buffer];
    const successReq = JSON.parse(successEvent.toString("utf8")) as Record<string, unknown>;
    ws.send(
      JSON.stringify({
        req_id: successReq.req_id,
        response: "200",
        data: {
          type: "get_clients_response",
          clients: [{ mac: "AA:BB:CC:DD:EE:FF", ip: "192.168.1.10" }],
          req_id: successReq.req_id,
        },
      }),
    );

    const success = await successPromise;
    expect(success.op).toBe("get_clients_response");
    expect(Array.isArray(success.clients)).toBe(true);

    const errorPromise = bridge.callDevice({
      deviceId: "dev-3",
      op: "kickoff",
      payload: {
        client_ip: "192.168.1.10",
        client_mac: "AA:BB:CC:DD:EE:FF",
        gw_id: "gw-1",
      },
    });

    const [errorEvent] = (await once(ws, "message")) as [Buffer];
    const errorReq = JSON.parse(errorEvent.toString("utf8")) as Record<string, unknown>;
    ws.send(
      JSON.stringify({
        req_id: errorReq.req_id,
        response: "200",
        data: {
          type: "kickoff_error",
          error: "Client not found",
          req_id: errorReq.req_id,
        },
      }),
    );

    await expect(errorPromise).rejects.toThrow("Client not found");

    ws.close();
    await once(ws, "close");
  });

  it("rejects forged responses from a different socket for the same req_id", async () => {
    const bridge = new ApFreeWifidogBridge({
      config: resolveApFreeWifidogConfig({
        enabled: true,
        bind: "127.0.0.1",
        port: 19207,
        path: "/ws/wifidogx",
        requestTimeoutMs: 3000,
      }),
      logger: createLogger(),
    });
    bridges.push(bridge);
    await bridge.start();

    const wsA = new WebSocket("ws://127.0.0.1:19207/ws/wifidogx");
    const wsB = new WebSocket("ws://127.0.0.1:19207/ws/wifidogx");
    await once(wsA, "open");
    await once(wsB, "open");

    wsA.send(JSON.stringify({ op: "connect", device_id: "dev-a", gateway: [] }));
    wsB.send(JSON.stringify({ op: "connect", device_id: "dev-b", gateway: [] }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const responsePromise = bridge.callDevice({
      deviceId: "dev-a",
      op: "get_status",
    });

    const [messageEvent] = (await once(wsA, "message")) as [Buffer];
    const outbound = JSON.parse(messageEvent.toString("utf8")) as Record<string, unknown>;

    wsB.send(
      JSON.stringify({
        op: "get_status_response",
        req_id: outbound.req_id,
        data: { service: "forged" },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    wsA.send(
      JSON.stringify({
        op: "get_status_response",
        req_id: outbound.req_id,
        data: { service: "legit" },
      }),
    );

    const response = await responsePromise;
    expect(response.data).toEqual({ service: "legit" });

    wsA.terminate();
    wsB.terminate();
  });

  it("generates unique random hex string req_ids for concurrent requests", async () => {
    const bridge = new ApFreeWifidogBridge({
      config: resolveApFreeWifidogConfig({
        enabled: true,
        bind: "127.0.0.1",
        port: 19218,
        path: "/ws/wifidogx",
        requestTimeoutMs: 3000,
      }),
      logger: createLogger(),
    });
    bridges.push(bridge);
    await bridge.start();

    const wsA = new WebSocket("ws://127.0.0.1:19218/ws/wifidogx");
    const wsB = new WebSocket("ws://127.0.0.1:19218/ws/wifidogx");
    await once(wsA, "open");
    await once(wsB, "open");

    wsA.send(JSON.stringify({ op: "connect", device_id: "dev-roll-a", gateway: [] }));
    wsB.send(JSON.stringify({ op: "connect", device_id: "dev-roll-b", gateway: [] }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const responsePromiseA = bridge.callDevice({
      deviceId: "dev-roll-a",
      op: "get_status",
    });

    const [messageEventA] = (await once(wsA, "message")) as [Buffer];
    const outboundA = JSON.parse(messageEventA.toString("utf8")) as Record<string, unknown>;
    expect(typeof outboundA.req_id).toBe("string");
    expect(outboundA.req_id as string).toMatch(/^[0-9a-f]{16}$/);

    const responsePromiseB = bridge.callDevice({
      deviceId: "dev-roll-b",
      op: "get_status",
    });

    const [messageEventB] = (await once(wsB, "message")) as [Buffer];
    const outboundB = JSON.parse(messageEventB.toString("utf8")) as Record<string, unknown>;
    expect(typeof outboundB.req_id).toBe("string");
    expect(outboundB.req_id as string).toMatch(/^[0-9a-f]{16}$/);
    expect(outboundA.req_id).not.toBe(outboundB.req_id);

    wsA.send(
      JSON.stringify({
        op: "get_status_response",
        req_id: outboundA.req_id,
        data: { service: "roll-a" },
      }),
    );
    wsB.send(
      JSON.stringify({
        op: "get_status_response",
        req_id: outboundB.req_id,
        data: { service: "roll-b" },
      }),
    );

    await expect(responsePromiseA).resolves.toMatchObject({
      data: { service: "roll-a" },
    });
    await expect(responsePromiseB).resolves.toMatchObject({
      data: { service: "roll-b" },
    });

    wsA.terminate();
    wsB.terminate();
  });

  it("serializes all requests for the same device until prior request completes", async () => {
    const bridge = new ApFreeWifidogBridge({
      config: resolveApFreeWifidogConfig({
        enabled: true,
        bind: "127.0.0.1",
        port: 19220,
        path: "/ws/wifidogx",
        requestTimeoutMs: 3000,
      }),
      logger: createLogger(),
    });
    bridges.push(bridge);
    await bridge.start();

    const ws = new WebSocket("ws://127.0.0.1:19220/ws/wifidogx");
    await once(ws, "open");
    ws.send(JSON.stringify({ op: "connect", device_id: "dev-serial", gateway: [] }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const firstPromise = bridge.callDevice({
      deviceId: "dev-serial",
      op: "get_status",
    });
    const secondPromise = bridge.callDevice({
      deviceId: "dev-serial",
      op: "get_sys_info",
    });

    const [firstOutboundEvent] = (await once(ws, "message")) as [Buffer];
    const firstOutbound = JSON.parse(firstOutboundEvent.toString("utf8")) as Record<
      string,
      unknown
    >;
    expect(firstOutbound.op).toBe("get_status");

    let receivedSecondBeforeFirstResponse = false;
    const secondMessageProbe = () => {
      receivedSecondBeforeFirstResponse = true;
    };
    ws.once("message", secondMessageProbe);
    await new Promise((resolve) => setTimeout(resolve, 120));
    ws.off("message", secondMessageProbe);
    expect(receivedSecondBeforeFirstResponse).toBe(false);

    ws.send(
      JSON.stringify({
        op: "get_status_response",
        req_id: firstOutbound.req_id,
        data: { service: "serial-a" },
      }),
    );
    await expect(firstPromise).resolves.toMatchObject({
      data: { service: "serial-a" },
    });

    const [secondOutboundEvent] = (await once(ws, "message")) as [Buffer];
    const secondOutbound = JSON.parse(secondOutboundEvent.toString("utf8")) as Record<
      string,
      unknown
    >;
    expect(secondOutbound.op).toBe("get_sys_info");

    ws.send(
      JSON.stringify({
        op: "get_sys_info_response",
        req_id: secondOutbound.req_id,
        data: { memfree: 12345 },
      }),
    );
    await expect(secondPromise).resolves.toMatchObject({
      data: { memfree: 12345 },
    });

    ws.terminate();
  });

  it("cancels stale pending requests immediately when a socket is superseded", async () => {
    const bridge = new ApFreeWifidogBridge({
      config: resolveApFreeWifidogConfig({
        enabled: true,
        bind: "127.0.0.1",
        port: 19221,
        path: "/ws/wifidogx",
        requestTimeoutMs: 5000,
      }),
      logger: createLogger(),
    });
    bridges.push(bridge);
    await bridge.start();

    const wsOld = new WebSocket("ws://127.0.0.1:19221/ws/wifidogx");
    await once(wsOld, "open");
    wsOld.send(JSON.stringify({ op: "connect", device_id: "dev-supersede", gateway: [] }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const firstPromise = bridge.callDevice({
      deviceId: "dev-supersede",
      op: "get_status",
    });
    const secondPromise = bridge.callDevice({
      deviceId: "dev-supersede",
      op: "get_sys_info",
    });

    const [firstOutboundEvent] = (await once(wsOld, "message")) as [Buffer];
    const firstOutbound = JSON.parse(firstOutboundEvent.toString("utf8")) as Record<
      string,
      unknown
    >;

    const internals = bridge as unknown as {
      sessions: Map<string, { socket: { close: (code?: number, reason?: string) => void } }>;
    };
    const activeSession = internals.sessions.get("dev-supersede");
    expect(activeSession).toBeTruthy();
    const closeSpy = vi.fn();
    if (activeSession) {
      activeSession.socket.close = closeSpy;
    }

    const wsNew = new WebSocket("ws://127.0.0.1:19221/ws/wifidogx");
    await once(wsNew, "open");
    wsNew.send(JSON.stringify({ op: "heartbeat", device_id: "dev-supersede", gateway: [] }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(closeSpy).toHaveBeenCalled();
    await expect(firstPromise).rejects.toThrow("device session superseded: dev-supersede");

    wsOld.send(
      JSON.stringify({
        op: "get_status_response",
        req_id: firstOutbound.req_id,
        data: { service: "stale" },
      }),
    );

    const [secondOutboundEvent] = (await once(wsNew, "message")) as [Buffer];
    const secondOutbound = JSON.parse(secondOutboundEvent.toString("utf8")) as Record<
      string,
      unknown
    >;
    expect(secondOutbound.op).toBe("get_sys_info");

    wsNew.send(
      JSON.stringify({
        op: "get_sys_info_response",
        req_id: secondOutbound.req_id,
        data: { memfree: 9876 },
      }),
    );

    await expect(secondPromise).resolves.toMatchObject({
      data: { memfree: 9876 },
    });

    wsOld.terminate();
    wsNew.terminate();
  });

  it("tracks AWAS pending state by device and req_id", async () => {
    const bridge = new ApFreeWifidogBridge({
      config: resolveApFreeWifidogConfig({
        enabled: true,
        bind: "127.0.0.1",
        port: 19193,
        path: "/ws/wifidogx",
        requestTimeoutMs: 3000,
      }),
      logger: createLogger(),
    });
    bridges.push(bridge);
    await bridge.start();

    const awasForward = vi.fn();
    (
      bridge as unknown as { awasProxy: { forwardToAwas: typeof awasForward } }
    ).awasProxy.forwardToAwas = awasForward;

    const ws1 = new WebSocket("ws://127.0.0.1:19193/ws/wifidogx");
    const ws2 = new WebSocket("ws://127.0.0.1:19193/ws/wifidogx");
    await once(ws1, "open");
    await once(ws2, "open");

    ws1.send(JSON.stringify({ op: "connect", device_id: "dev-a", gateway: [] }));
    ws2.send(JSON.stringify({ op: "connect", device_id: "dev-b", gateway: [] }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    awasForward.mockClear();

    (
      bridge as unknown as {
        handleAwasCommand: (deviceId: string, command: Record<string, unknown>) => void;
      }
    ).handleAwasCommand("dev-a", { type: "auth", req_id: 7, client_ip: "192.168.1.10" });
    (
      bridge as unknown as {
        handleAwasCommand: (deviceId: string, command: Record<string, unknown>) => void;
      }
    ).handleAwasCommand("dev-b", { type: "auth", req_id: 7, client_ip: "192.168.1.11" });

    await once(ws1, "message");
    await once(ws2, "message");

    ws1.send(JSON.stringify({ op: "auth_response", req_id: 7, ok: true }));
    ws2.send(JSON.stringify({ op: "auth_response", req_id: 7, ok: true }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(awasForward).toHaveBeenCalledTimes(2);
    expect(awasForward).toHaveBeenCalledWith(
      "dev-a",
      expect.objectContaining({ op: "auth_response", req_id: 7 }),
    );
    expect(awasForward).toHaveBeenCalledWith(
      "dev-b",
      expect.objectContaining({ op: "auth_response", req_id: 7 }),
    );

    ws1.terminate();
    ws2.terminate();
  });

  it("rejects AWAS commands that collide with local pending req_id on the same device", async () => {
    const bridge = new ApFreeWifidogBridge({
      config: resolveApFreeWifidogConfig({
        enabled: true,
        bind: "127.0.0.1",
        port: 19214,
        path: "/ws/wifidogx",
        requestTimeoutMs: 3000,
      }),
      logger: createLogger(),
    });
    bridges.push(bridge);
    await bridge.start();

    const awasForward = vi.fn();
    (
      bridge as unknown as { awasProxy: { forwardToAwas: typeof awasForward } }
    ).awasProxy.forwardToAwas = awasForward;

    const ws = new WebSocket("ws://127.0.0.1:19214/ws/wifidogx");
    await once(ws, "open");
    ws.send(JSON.stringify({ op: "connect", device_id: "dev-collision", gateway: [] }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    awasForward.mockClear();

    const responsePromise = bridge.callDevice({
      deviceId: "dev-collision",
      op: "get_status",
    });

    const [messageEvent] = (await once(ws, "message")) as [Buffer];
    const outbound = JSON.parse(messageEvent.toString("utf8")) as Record<string, unknown>;

    (
      bridge as unknown as {
        handleAwasCommand: (deviceId: string, command: Record<string, unknown>) => void;
      }
    ).handleAwasCommand("dev-collision", {
      type: "auth",
      req_id: outbound.req_id,
      client_ip: "192.168.1.10",
    });

    expect(awasForward).toHaveBeenCalledWith(
      "dev-collision",
      expect.objectContaining({
        op: "request_error",
        req_id: String(outbound.req_id),
        error: "request id collision with local pending request",
      }),
    );

    ws.send(
      JSON.stringify({
        op: "get_status_response",
        req_id: outbound.req_id,
        data: { service: "local-still-ok" },
      }),
    );
    const response = await responsePromise;
    expect(response.data).toEqual({ service: "local-still-ok" });

    ws.terminate();
  });

  it("rejects forged AWAS replies from a non-active socket for the same device and req_id", async () => {
    const bridge = new ApFreeWifidogBridge({
      config: resolveApFreeWifidogConfig({
        enabled: true,
        bind: "127.0.0.1",
        port: 19210,
        path: "/ws/wifidogx",
        requestTimeoutMs: 3000,
      }),
      logger: createLogger(),
    });
    bridges.push(bridge);
    await bridge.start();

    const awasForward = vi.fn();
    (
      bridge as unknown as { awasProxy: { forwardToAwas: typeof awasForward } }
    ).awasProxy.forwardToAwas = awasForward;

    const wsActive = new WebSocket("ws://127.0.0.1:19210/ws/wifidogx");
    const wsForged = new WebSocket("ws://127.0.0.1:19210/ws/wifidogx");
    await once(wsActive, "open");
    await once(wsForged, "open");

    wsActive.send(JSON.stringify({ op: "connect", device_id: "dev-aws", gateway: [] }));
    wsForged.send(JSON.stringify({ op: "connect", device_id: "dev-other", gateway: [] }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    awasForward.mockClear();

    (
      bridge as unknown as {
        handleAwasCommand: (deviceId: string, command: Record<string, unknown>) => void;
      }
    ).handleAwasCommand("dev-aws", { type: "auth", req_id: 9, client_ip: "192.168.1.10" });

    await once(wsActive, "message");

    wsForged.send(
      JSON.stringify({
        op: "auth_response",
        device_id: "dev-aws",
        req_id: 9,
        ok: true,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(awasForward).not.toHaveBeenCalled();

    wsActive.send(
      JSON.stringify({
        op: "auth_response",
        device_id: "dev-aws",
        req_id: 9,
        ok: true,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(awasForward).toHaveBeenCalledTimes(1);
    expect(awasForward).toHaveBeenCalledWith(
      "dev-aws",
      expect.objectContaining({ op: "auth_response", req_id: 9 }),
    );

    wsActive.terminate();
    wsForged.terminate();
  });

  it("tracks AWAS req_id 0 as a pending request", async () => {
    const bridge = new ApFreeWifidogBridge({
      config: resolveApFreeWifidogConfig({
        enabled: true,
        bind: "127.0.0.1",
        port: 19205,
        path: "/ws/wifidogx",
        requestTimeoutMs: 3000,
      }),
      logger: createLogger(),
    });
    bridges.push(bridge);
    await bridge.start();

    const awasForward = vi.fn();
    (
      bridge as unknown as { awasProxy: { forwardToAwas: typeof awasForward } }
    ).awasProxy.forwardToAwas = awasForward;

    const ws = new WebSocket("ws://127.0.0.1:19205/ws/wifidogx");
    await once(ws, "open");
    ws.send(JSON.stringify({ op: "connect", device_id: "dev-zero", gateway: [] }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    awasForward.mockClear();

    (
      bridge as unknown as {
        handleAwasCommand: (deviceId: string, command: Record<string, unknown>) => void;
      }
    ).handleAwasCommand("dev-zero", { type: "auth", req_id: 0, client_ip: "192.168.1.10" });

    await once(ws, "message");

    ws.send(JSON.stringify({ op: "auth_response", req_id: 0, ok: true }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(awasForward).toHaveBeenCalledTimes(1);
    expect(awasForward).toHaveBeenCalledWith(
      "dev-zero",
      expect.objectContaining({ op: "auth_response", req_id: 0 }),
    );

    ws.terminate();
  });

  it("clears AWAS pending timers when a device disconnects", async () => {
    const bridge = new ApFreeWifidogBridge({
      config: resolveApFreeWifidogConfig({
        enabled: false,
        requestTimeoutMs: 150,
      }),
      logger: createLogger(),
    });

    const awasForward = vi.fn();
    (
      bridge as unknown as { awasProxy: { forwardToAwas: typeof awasForward } }
    ).awasProxy.forwardToAwas = awasForward;

    const socket = {
      readyState: WebSocket.OPEN,
      send(_payload: string, cb?: (error?: Error) => void) {
        cb?.();
      },
    } as unknown as WebSocket;

    (
      bridge as unknown as {
        sessions: Map<string, { socket: WebSocket; snapshot: Record<string, unknown> }>;
        socketToDeviceId: Map<WebSocket, string>;
        handleAwasCommand: (deviceId: string, command: Record<string, unknown>) => void;
        handleClose: (socket: WebSocket) => void;
      }
    ).sessions.set("dev-disconnect", {
      socket,
      snapshot: {
        deviceId: "dev-disconnect",
        connectedAtMs: Date.now(),
        lastSeenAtMs: Date.now(),
      },
    });
    (
      bridge as unknown as {
        socketToDeviceId: Map<WebSocket, string>;
      }
    ).socketToDeviceId.set(socket, "dev-disconnect");

    (
      bridge as unknown as {
        handleAwasCommand: (deviceId: string, command: Record<string, unknown>) => void;
      }
    ).handleAwasCommand("dev-disconnect", { type: "auth", req_id: 42, client_ip: "192.168.1.10" });
    (
      bridge as unknown as {
        handleClose: (socket: WebSocket) => void;
      }
    ).handleClose(socket);

    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(awasForward).not.toHaveBeenCalledWith(
      "dev-disconnect",
      expect.objectContaining({ op: "request_error", req_id: "42" }),
    );
  });

  it("cancels AWAS pending timers during bridge shutdown", async () => {
    const bridge = new ApFreeWifidogBridge({
      config: resolveApFreeWifidogConfig({
        enabled: false,
        requestTimeoutMs: 150,
      }),
      logger: createLogger(),
    });

    const timeoutSpy = vi.fn();
    const timer = setTimeout(timeoutSpy, 150) as unknown as ReturnType<typeof setTimeout>;
    (
      bridge as unknown as {
        awasPending: Map<string, Map<string, ReturnType<typeof setTimeout>>>;
      }
    ).awasPending.set("dev-stop", new Map([["42", timer]]));

    await bridge.stop();
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(timeoutSpy).not.toHaveBeenCalled();
    expect(
      (
        bridge as unknown as {
          awasPending: Map<string, Map<string, ReturnType<typeof setTimeout>>>;
        }
      ).awasPending.size,
    ).toBe(0);
  });

  it("clears AWAS state for one device without affecting prefixed device ids", () => {
    const bridge = new ApFreeWifidogBridge({
      config: resolveApFreeWifidogConfig({
        enabled: false,
        requestTimeoutMs: 150,
      }),
      logger: createLogger(),
    });

    const timerA = setTimeout(() => {}, 1_000) as unknown as ReturnType<typeof setTimeout>;
    const timerB = setTimeout(() => {}, 1_000) as unknown as ReturnType<typeof setTimeout>;

    (
      bridge as unknown as {
        awasPending: Map<string, Map<string, ReturnType<typeof setTimeout>>>;
        clearAwasStateForDevice: (deviceId: string) => void;
      }
    ).awasPending.set("dev", new Map([["1", timerA]]));
    (
      bridge as unknown as {
        awasPending: Map<string, Map<string, ReturnType<typeof setTimeout>>>;
      }
    ).awasPending.set("dev:backup", new Map([["1", timerB]]));

    (
      bridge as unknown as {
        clearAwasStateForDevice: (deviceId: string) => void;
      }
    ).clearAwasStateForDevice("dev");

    expect(
      (
        bridge as unknown as {
          awasPending: Map<string, Map<string, ReturnType<typeof setTimeout>>>;
        }
      ).awasPending.has("dev"),
    ).toBe(false);
    expect(
      (
        bridge as unknown as {
          awasPending: Map<string, Map<string, ReturnType<typeof setTimeout>>>;
        }
      ).awasPending.has("dev:backup"),
    ).toBe(true);

    clearTimeout(timerB);
  });

  it("does not reject new-session requests when a superseded socket closes", async () => {
    const bridge = new ApFreeWifidogBridge({
      config: resolveApFreeWifidogConfig({
        enabled: true,
        bind: "127.0.0.1",
        port: 19204,
        path: "/ws/wifidogx",
        requestTimeoutMs: 3000,
      }),
      logger: createLogger(),
    });
    bridges.push(bridge);
    await bridge.start();

    const wsOld = new WebSocket("ws://127.0.0.1:19204/ws/wifidogx");
    await once(wsOld, "open");
    wsOld.send(JSON.stringify({ op: "connect", device_id: "dev-reconnect", gateway: [] }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const wsNew = new WebSocket("ws://127.0.0.1:19204/ws/wifidogx");
    await once(wsNew, "open");
    wsNew.send(JSON.stringify({ op: "connect", device_id: "dev-reconnect", gateway: [] }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const responsePromise = bridge.callDevice({
      deviceId: "dev-reconnect",
      op: "get_status",
    });

    const [messageEvent] = (await once(wsNew, "message")) as [Buffer];
    const outbound = JSON.parse(messageEvent.toString("utf8")) as Record<string, unknown>;

    wsOld.terminate();
    await new Promise((resolve) => setTimeout(resolve, 50));

    wsNew.send(
      JSON.stringify({
        op: "get_status_response",
        req_id: outbound.req_id,
        data: { service: "ok-after-reconnect" },
      }),
    );

    const response = await responsePromise;
    expect(response.data).toEqual({ service: "ok-after-reconnect" });

    wsNew.terminate();
  });

  it("does not tear down AWAS state when a superseded socket closes", async () => {
    const bridge = new ApFreeWifidogBridge({
      config: resolveApFreeWifidogConfig({
        enabled: true,
        bind: "127.0.0.1",
        port: 19208,
        path: "/ws/wifidogx",
        requestTimeoutMs: 3000,
      }),
      logger: createLogger(),
    });
    bridges.push(bridge);
    await bridge.start();

    const removeProxy = vi.fn();
    (
      bridge as unknown as { awasProxy: { removeProxy: typeof removeProxy } }
    ).awasProxy.removeProxy = removeProxy;

    const wsOld = new WebSocket("ws://127.0.0.1:19208/ws/wifidogx");
    await once(wsOld, "open");
    wsOld.send(JSON.stringify({ op: "connect", device_id: "dev-aways", gateway: [] }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    removeProxy.mockClear();

    const wsNew = new WebSocket("ws://127.0.0.1:19208/ws/wifidogx");
    await once(wsNew, "open");
    wsNew.send(JSON.stringify({ op: "connect", device_id: "dev-aways", gateway: [] }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    wsOld.terminate();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(removeProxy).not.toHaveBeenCalled();

    wsNew.terminate();
  });

  it("does not tear down AWAS state when remapping a superseded socket", async () => {
    const bridge = new ApFreeWifidogBridge({
      config: resolveApFreeWifidogConfig({
        enabled: true,
        bind: "127.0.0.1",
        port: 19211,
        path: "/ws/wifidogx",
        requestTimeoutMs: 3000,
      }),
      logger: createLogger(),
    });
    bridges.push(bridge);
    await bridge.start();

    const removeProxy = vi.fn();
    (
      bridge as unknown as { awasProxy: { removeProxy: typeof removeProxy } }
    ).awasProxy.removeProxy = removeProxy;

    const wsActive = new WebSocket("ws://127.0.0.1:19211/ws/wifidogx");
    const wsSuperseded = new WebSocket("ws://127.0.0.1:19211/ws/wifidogx");
    await once(wsActive, "open");
    await once(wsSuperseded, "open");

    wsSuperseded.send(JSON.stringify({ op: "connect", device_id: "dev-old", gateway: [] }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    wsActive.send(JSON.stringify({ op: "connect", device_id: "dev-old", gateway: [] }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    removeProxy.mockClear();

    wsSuperseded.send(JSON.stringify({ op: "heartbeat", device_id: "dev-new", gateway: [] }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(removeProxy).not.toHaveBeenCalled();

    wsActive.terminate();
    wsSuperseded.terminate();
  });

  it("rejects connect and heartbeat from superseded sockets even when device_id changes", async () => {
    const port = await getFreePort();
    const bridge = new ApFreeWifidogBridge({
      config: resolveApFreeWifidogConfig({
        enabled: true,
        bind: "127.0.0.1",
        port,
        path: "/ws/wifidogx",
        requestTimeoutMs: 3000,
      }),
      logger: createLogger(),
    });
    bridges.push(bridge);
    await bridge.start();

    const wsCurrent = new WebSocket(`ws://127.0.0.1:${port}/ws/wifidogx`);
    const wsSuperseded = new WebSocket(`ws://127.0.0.1:${port}/ws/wifidogx`);
    const wsOther = new WebSocket(`ws://127.0.0.1:${port}/ws/wifidogx`);
    await Promise.all([once(wsCurrent, "open"), once(wsSuperseded, "open"), once(wsOther, "open")]);

    wsSuperseded.send(JSON.stringify({ op: "connect", device_id: "dev-old", gateway: [] }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    wsCurrent.send(JSON.stringify({ op: "connect", device_id: "dev-old", gateway: [] }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    wsOther.send(JSON.stringify({ op: "connect", device_id: "dev-new", gateway: [] }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    wsSuperseded.send(JSON.stringify({ op: "heartbeat", device_id: "dev-new", gateway: [] }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(bridge.getDevice("dev-old")?.remoteAddress).toBeDefined();
    expect(bridge.getDevice("dev-new")?.remoteAddress).toBeDefined();
    expect(bridge.getDevice("dev-old")?.deviceId).toBe("dev-old");
    expect(bridge.getDevice("dev-new")?.deviceId).toBe("dev-new");
    expect(wsSuperseded.readyState).not.toBe(WebSocket.OPEN);

    const responsePromise = bridge.callDevice({
      deviceId: "dev-new",
      op: "get_status",
    });

    const [outboundRaw] = (await once(wsOther, "message")) as [Buffer];
    const outbound = JSON.parse(outboundRaw.toString()) as { req_id: string };
    wsOther.send(
      JSON.stringify({
        op: "get_status_response",
        req_id: outbound.req_id,
        data: { ok: true },
      }),
    );

    await expect(responsePromise).resolves.toMatchObject({ data: { ok: true } });

    wsCurrent.terminate();
    wsOther.terminate();
  });
});
