import { X509Certificate } from "node:crypto";
import { createServer as createHttpServer, type IncomingHttpHeaders } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect, createServer as createTcpServer } from "node:net";
import { checkServerIdentity } from "node:tls";
import { installGlobalProxy, type ProxylineHandle } from "@openclaw/proxyline";
import { afterEach, beforeEach, describe, expect, it, test, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../../test/helpers/tls-fixture.js";
import { validatePreviousConnectParams } from "../../gateway-protocol/src/connect-compatibility.test-support.js";
import {
  GATEWAY_SERVER_CAPS,
  PROTOCOL_VERSION,
  validateConnectParams,
} from "../../gateway-protocol/src/index.js";
import {
  GatewayClient,
  GatewayClientRequestTimeoutError,
  type GatewayClientCloseInfo,
  type GatewayClientOptions,
} from "./client.js";
import {
  transportFixture,
  sendFrame,
  sendChallenge,
  sendResponse,
} from "./client.transport.test-support.js";
import {
  GatewayProtocolRequestTimeoutError,
  type GatewayProtocolSocket,
} from "./protocol-client.js";
import { MAX_SAFE_TIMEOUT_DELAY_MS } from "./timeouts.js";
import { rawDataToString } from "./websocket-data.js";
import { resolveGatewayWebSocketTransport } from "./websocket-transport.js";
import { WebSocket } from "./websocket.test-support.js";

const fingerprint = new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256;
const tlsServer = () => createHttpsServer({ key: TEST_TLS_KEY_PEM, cert: TEST_TLS_CERT_PEM });
let proxy: ProxylineHandle | undefined;
const {
  client: createClient,
  startClient,
  websocketServer,
  startWebSocketServer,
  listen,
  trackSocket,
  waitForSocketDrain,
} = transportFixture(() => {
  proxy?.stop();
  proxy = undefined;
});

async function startProxy(targetPort: number) {
  const server = createHttpServer();
  let tunnels = 0;
  server.on("connect", (_request, downstream, head) => {
    tunnels++;
    const upstream = connect(targetPort, "127.0.0.1", () => {
      downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      downstream.pipe(upstream).pipe(downstream);
    });
    trackSocket(upstream);
    downstream.on("error", () => upstream.destroy());
    upstream.on("error", () => downstream.destroy());
    downstream.once("close", () => upstream.destroy());
    upstream.once("close", () => downstream.destroy());
  });
  const port = await listen(server);
  proxy = installGlobalProxy({ mode: "managed", proxyUrl: `http://127.0.0.1:${port}` });
  return () => tunnels;
}

it.each([
  { peer: "localhost", servername: "localhost", valid: true },
  { peer: "other.localhost", servername: "other.localhost", valid: false },
  { peer: "127.0.0.1", servername: "", valid: false },
])(
  "validates the original TLS peer $peer behind a translated endpoint",
  ({ peer, servername, valid }) => {
    const { options } = resolveGatewayWebSocketTransport({
      url: "wss://127.0.0.1:18789",
      tlsServerName: peer,
      options: {},
    });
    const certificate = new X509Certificate(TEST_TLS_CERT_PEM).toLegacyObject();
    const error = (options.checkServerIdentity ?? checkServerIdentity)("127.0.0.1", certificate);
    expect(error === undefined).toBe(valid);
    expect(options.servername).toBe(servername);
    expect(options.rejectUnauthorized).not.toBe(false);
  },
);

it.each([
  { name: "wrong pin with Expect and URL auth", pin: "ab".repeat(32), managed: false },
  { name: "wrong pin with Expect and URL auth", pin: "ab".repeat(32), managed: true },
  { name: "correct pin", pin: fingerprint, managed: false },
  { name: "CA validation without a pin", pin: undefined, managed: false },
])("validates $name before upgrade (managed proxy: $managed)", async ({ pin, managed }) => {
  const server = tlsServer();
  let httpBytes = 0;
  let upgrades = 0;
  let headers: IncomingHttpHeaders | undefined;
  server.on("secureConnection", (socket) => {
    socket.on("data", (chunk: Buffer) => {
      httpBytes += chunk.length;
    });
  });
  const wss = websocketServer(server);
  const outcome = createDeferred<Error | "open">();
  const closed = createDeferred<GatewayClientCloseInfo | undefined>();
  wss.on("connection", (_socket, request) => {
    upgrades++;
    headers = request.headers;
    if (pin === fingerprint) {
      outcome.resolve("open");
    }
  });
  const port = await listen(server);
  const tunnels = managed ? await startProxy(port) : undefined;
  const { client } = startClient({
    url: `wss://fixture:synthetic-password@127.0.0.1:${port}`,
    tlsFingerprint: pin,
    deviceIdentity: null,
    edgeAuthHeaders: { "X-Test-Edge-Auth": "synthetic-test-edge-token", eXpEcT: "100-continue" },
    onConnectError: outcome.resolve,
    onClose: (_code, _reason, info) => closed.resolve(info),
  });
  const result = await outcome.promise;
  await client.stopAndWait();
  await waitForSocketDrain();
  if (pin === fingerprint) {
    expect(result).toBe("open");
    expect(upgrades).toBe(1);
    expect(headers).toMatchObject({
      "x-test-edge-auth": "synthetic-test-edge-token",
      expect: "100-continue",
      authorization: `Basic ${Buffer.from("fixture:synthetic-password").toString("base64")}`,
    });
  } else {
    expect(result).toBeInstanceOf(Error);
    expect(String(result)).toMatch(pin ? /tls fingerprint mismatch/i : /certificate/i);
    expect({ httpBytes, upgrades }).toEqual({ httpBytes: 0, upgrades: 0 });
    expect(await closed.promise).toMatchObject({
      phase: "pre-hello",
      socketOpened: false,
      transportValidated: false,
      connectRequestSent: false,
    });
  }
  expect(tunnels?.() ?? 0).toBe(managed ? 1 : 0);
});

it.each(["timeout", "cancel"])("cleans up a stalled TLS handshake on %s", async (action) => {
  const accepted = createDeferred();
  const server = createTcpServer((socket) => {
    socket.on("data", () => accepted.resolve());
  });
  const port = await listen(server);
  const { client, failed } = startClient({
    url: `wss://127.0.0.1:${port}`,
    tlsFingerprint: fingerprint,
    deviceIdentity: null,
    preauthHandshakeTimeoutMs: 100,
  });
  await accepted.promise;
  if (action === "timeout") {
    await expect(failed).resolves.toMatchObject({
      message: "Opening handshake has timed out",
      code: "ETIMEDOUT",
    });
  }
  await client.stopAndWait();
  await waitForSocketDrain();
});

it("rejects non-empty edge auth headers before a plaintext WebSocket dial", async () => {
  const { client, failed } = startClient({
    url: "ws://127.0.0.1:18789",
    edgeAuthHeaders: { "X-Edge-Auth": "test-secret" },
  });

  await expect(failed).resolves.toMatchObject({
    message: "edge auth headers require a wss:// Gateway URL",
  });
  client.stop();
});

it("does not follow an edge redirect and redacts its Location URL", async () => {
  let redirected = false;
  const targetHttpsServer = tlsServer();
  const targetWebSocketServer = websocketServer(targetHttpsServer);
  targetWebSocketServer.on("connection", (socket) => {
    redirected = true;
    socket.close();
  });
  const targetPort = await listen(targetHttpsServer);

  const edgeHttpsServer = tlsServer();
  edgeHttpsServer.on("upgrade", (_request, socket) => {
    socket.end(
      `HTTP/1.1 302 Found\r\nLocation: wss://127.0.0.1:${targetPort}/?access_token=test-token&safe=1\r\nConnection: close\r\n\r\n`,
    );
  });
  const edgePort = await listen(edgeHttpsServer);
  const { client, failed } = startClient({
    url: `wss://127.0.0.1:${edgePort}`,
    edgeAuthHeaders: { "X-Edge-Auth": "test-secret" },
    tlsFingerprint: fingerprint,
  });

  await expect(failed).resolves.toMatchObject({
    details: {
      reason: "websocket-upgrade-rejected",
      httpStatus: 302,
      location: `wss://127.0.0.1:${targetPort}/?access_token=***&safe=1`,
    },
  });
  expect(redirected).toBe(false);
  await client.stopAndWait();
});

async function rejectedUpgrade(status: number, body: string, end = true) {
  const port = await listen(
    createHttpServer((_req, res) => {
      res.writeHead(status, { "Content-Type": end ? "application/json" : "text/plain" });
      if (end) {
        res.end(body);
      } else {
        res.write(body);
      }
    }),
  );
  return startClient({ url: `ws://127.0.0.1:${port}` }).failed;
}

it.each([
  { advertised: false, modelCatalog: { agentId: "alpha" } },
  { advertised: true, modelCatalog: { agentId: "alpha", sessionKey: "agent:alpha:saved" } },
])(
  "negotiates catalog input with a compatible Gateway: %j",
  async ({ advertised, modelCatalog }) => {
    const { server: wss, url } = await startWebSocketServer();
    const connected = createDeferred();
    const received = createDeferred<{ id: string; params: unknown }>();
    wss.on("connection", (socket) => {
      sendChallenge(socket, {
        nonce: "catalog-handshake",
        ts: Date.now(),
        ...(advertised ? { capabilities: [GATEWAY_SERVER_CAPS.MODEL_CATALOG_SNAPSHOT] } : {}),
      });
      socket.once("message", (raw) => {
        const frame = JSON.parse(rawDataToString(raw)) as { id: string; params: unknown };
        received.resolve(frame);
        const valid = advertised
          ? validateConnectParams(frame.params)
          : validatePreviousConnectParams(frame.params);
        sendFrame(socket, {
          type: "res",
          id: frame.id,
          ok: valid,
          ...(valid
            ? { payload: { type: "hello-ok", protocol: PROTOCOL_VERSION } }
            : { error: { code: "INVALID_REQUEST", message: "invalid connect params" } }),
        });
      });
    });
    startClient({
      url,
      deviceIdentity: null,
      modelCatalog,
      onHelloOk: () => connected.resolve(),
      onConnectError: connected.reject,
    });
    await connected.promise;
    const frame = await received.promise;
    if (advertised) {
      expect(frame.params).toMatchObject({ modelCatalog, caps: ["model-catalog-snapshot"] });
    } else {
      expect(frame.params).not.toHaveProperty("modelCatalog");
      expect(frame.params).toMatchObject({ caps: [] });
    }
  },
);

it("keeps a hello received during WebSocket closing in the pre-hello failure path", async () => {
  const { server: wss, url } = await startWebSocketServer();
  const onHelloOk = vi.fn();
  const onConnectError = vi.fn();
  const onClose = vi.fn();
  const onEvent = vi.fn();
  const closed = createDeferred();
  const lateFramesWritten = createDeferred();
  const { client } = startClient({
    url,
    deviceIdentity: null,
    onHelloOk,
    onConnectError,
    onClose: (...args) => {
      onClose(...args);
      closed.resolve();
    },
    onEvent,
  });
  wss.on("connection", (socket) => {
    sendChallenge(socket, { nonce: "synthetic-nonce", ts: Date.now() });
    socket.once("message", (raw) => {
      const frame = JSON.parse(rawDataToString(raw)) as { id: string };
      // Write both frames before admitting the peer's close reply, preserving
      // their wire order without waiting for retired application callbacks.
      socket.pause();
      client.updateNodeManifest({ caps: [], commands: [] });
      sendResponse(socket, frame.id, { type: "hello-ok" });
      socket.send(JSON.stringify({ type: "event", event: "late-hello-marker" }), (error) => {
        socket.resume();
        if (error) {
          lateFramesWritten.reject(error);
        } else {
          lateFramesWritten.resolve();
        }
      });
    });
  });
  await Promise.all([lateFramesWritten.promise, closed.promise]);
  expect(onEvent).not.toHaveBeenCalled();
  expect(onHelloOk).not.toHaveBeenCalled();
  expect(onConnectError).toHaveBeenCalledExactlyOnceWith(
    new Error("gateway closed (1012): node manifest changed"),
  );
  expect(onClose).toHaveBeenCalledExactlyOnceWith(
    1012,
    "node manifest changed",
    expect.objectContaining({ phase: "pre-hello", connectRequestSent: true }),
  );
});

it.each([true, false])("preserves upgrade rejection details (typed=%s)", async (typed) => {
  const gatewayErrorType = "proxy_attribution_required";
  const gatewayErrorMessage = "Configure gateway.trustedProxies narrowly";
  const body = typed
    ? JSON.stringify({ error: { type: gatewayErrorType, message: gatewayErrorMessage } })
    : "null";
  const error = await rejectedUpgrade(403, body);
  expect(error).toMatchObject({
    details: {
      reason: "websocket-upgrade-rejected",
      httpStatus: 403,
      ...(typed ? { gatewayErrorType, gatewayErrorMessage } : {}),
    },
  });
  if (!typed) {
    expect(error).not.toMatchObject({ details: { gatewayErrorType: expect.anything() } });
  }
});

it("caps a rejected websocket upgrade body before the peer ends it", async () => {
  const omittedTail = "omitted-tail-marker";
  const error = await rejectedUpgrade(503, `${"x".repeat(3_000)}${omittedTail}`, false);

  expect(error.message).toHaveLength(
    "gateway rejected websocket upgrade (HTTP 503): ".length + 2 * 1024,
  );
  expect(error.message).not.toContain(omittedTail);
});

test("decodes every ws raw-data shape", () => {
  expect(rawDataToString(Buffer.from("buffer"))).toBe("buffer");
  expect(rawDataToString(Uint8Array.from(Buffer.from("array-buffer")).buffer)).toBe("array-buffer");
  expect(rawDataToString([Buffer.from("frag"), Buffer.from("ments")])).toBe("fragments");
  expect(rawDataToString(Buffer.from([0xe9]), "latin1")).toBe("é");
});

type ProtocolHarness = {
  socket: GatewayProtocolSocket | null;
  stopped: boolean;
  generation: number;
  reconnectSupervisor: { reset(initialMs?: number): void };
  handleMessage: (socket: GatewayProtocolSocket, generation: number, raw: string) => void;
};

function protocolHarness(client: GatewayClient): ProtocolHarness {
  return (client as unknown as { protocol: ProtocolHarness }).protocol;
}

function syntheticClient(options: GatewayClientOptions) {
  const client = new GatewayClient(options);
  const send = vi.fn();
  const close = vi.fn();
  const protocol = protocolHarness(client);
  const socket: GatewayProtocolSocket = { isOpen: () => true, send, close };
  Object.assign(protocol, { socket, stopped: false, generation: 1 });
  Object.assign(client, { ws: { readyState: WebSocket.OPEN, send, close, terminate: vi.fn() } });
  return {
    client,
    send,
    close,
    receive: (frame: unknown) =>
      protocol.handleMessage(socket, protocol.generation, JSON.stringify(frame)),
    stop: async () => {
      client.stop();
      await vi.advanceTimersByTimeAsync(250);
    },
  };
}

function createWatchedGatewayClient(tickIntervalMs = 5) {
  const harness = syntheticClient({
    requestTimeoutMs: 100,
    tickWatchMinIntervalMs: 5,
    tickWatchTimeoutMs: 10,
  });
  Object.assign(harness.client, { tickIntervalMs, lastTick: Date.now() });
  (harness.client as unknown as { startTickWatch: () => void }).startTickWatch();
  return harness;
}

describe("GatewayClient", () => {
  beforeEach(() => {
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  afterEach(() => {
    // Timer spies must restore their fake functions before the clock uninstalls them.
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test("sends the configured websocket origin", async () => {
    const { server, url, origin } = await startWebSocketServer();
    const receivedOrigin = new Promise<string | undefined>((resolve) => {
      server.once("connection", (_socket, request) => resolve(request.headers.origin));
    });
    const client = createClient({ url, origin, connectChallengeTimeoutMs: 0 });
    client.start();

    await expect(receivedOrigin).resolves.toBe(origin);
  });

  test("returns non-sensitive connection metadata", () => {
    const client = new GatewayClient({
      clientName: "cli",
      mode: "backend",
      preauthHandshakeTimeoutMs: 30_000,
      deviceIdentity: {
        deviceId: "device-1",
        privateKeyPem: "private-key",
        publicKeyPem: "public-key",
      },
    });

    expect(client.getConnectionMetadata()).toEqual({
      clientName: "cli",
      hasDeviceIdentity: true,
      mode: "backend",
      preauthHandshakeTimeoutMs: 30_000,
    });
  });

  test("reconnects with updated node manifest metadata", () => {
    const { client, close } = syntheticClient({ caps: ["system"], commands: ["system.run"] });

    const manifest = {
      caps: ["canvas", "system"],
      commands: ["canvas.present", "system.run"],
      workerRuns: {
        bundleHash: "a".repeat(64),
        openclawVersion: "2026.8.12",
        protocolFeatures: ["worker-heartbeat-v1"],
      },
    };
    client.updateNodeManifest(structuredClone(manifest));

    expect(close).toHaveBeenCalledWith(1012, "node manifest changed");
    expect((client as unknown as { opts: Record<string, unknown> }).opts).toMatchObject(manifest);
  });

  test("rejects an unbounded request, reconnects, and does not replay it", async () => {
    const { server, url } = await startWebSocketServer();

    const methodsByConnection: string[][] = [];
    server.on("connection", (socket) => {
      const methods: string[] = [];
      methodsByConnection.push(methods);
      sendChallenge(socket, {
        nonce: `nonce-${methodsByConnection.length}`,
        ts: 1_777_777_777_000,
      });
      socket.on("message", (data) => {
        const frame = JSON.parse(rawDataToString(data)) as { id: string; method: string };
        methods.push(frame.method);
        if (frame.method === "connect") {
          sendResponse(socket, frame.id, {
            type: "hello-ok",
            protocol: PROTOCOL_VERSION,
            policy: { tickIntervalMs: 20 },
          });
          return;
        }
        if (frame.method === "status") {
          sendResponse(socket, frame.id, { status: "ok" });
        }
      });
    });

    const firstHello = createDeferred();
    const secondHello = createDeferred();
    const closeEvents: Array<{ code: number; reason: string }> = [];
    let helloCount = 0;
    const client = createClient({
      url,
      tickWatchMinIntervalMs: 5,
      onHelloOk: () => {
        helloCount += 1;
        if (helloCount === 1) {
          // Keep the real reconnect lifecycle fast without changing production defaults.
          protocolHarness(client).reconnectSupervisor.reset(10);
          firstHello.resolve();
          return;
        }
        secondHello.resolve();
      },
      onClose: (code, reason) => closeEvents.push({ code, reason }),
    });

    client.start();
    await firstHello.promise;
    const stalledRequest = client.request("chat.send", undefined, { expectFinal: true });
    void stalledRequest.catch(() => {});
    await expect(stalledRequest).rejects.toThrow("gateway closed (4000): tick timeout");
    await secondHello.promise;
    await expect(client.request("status")).resolves.toEqual({ status: "ok" });
    expect(closeEvents[0]).toEqual({ code: 4000, reason: "tick timeout" });
    expect(methodsByConnection.slice(0, 2)).toEqual([
      ["connect", "chat.send"],
      ["connect", "status"],
    ]);
    expect(methodsByConnection.flat().filter((method) => method === "chat.send")).toHaveLength(1);
  }, 5000);

  test("lets finite pending requests own their timeout when ticks are missing", async () => {
    vi.useFakeTimers();
    const { client, close, stop } = createWatchedGatewayClient();
    const request = client.request("status", undefined, { timeoutMs: 100 });
    const outcome = request.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(20);

    expect(close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(80);
    const error = await outcome;
    expect(error).toBeInstanceOf(GatewayClientRequestTimeoutError);
    expect(error).toBeInstanceOf(GatewayProtocolRequestTimeoutError);
    expect(error).toMatchObject({
      message: "gateway request timeout for status",
      code: "CLIENT_TIMEOUT",
      method: "status",
      timeoutMs: 100,
      requestSent: true,
    });
    await vi.advanceTimersByTimeAsync(5);

    expect(close).toHaveBeenCalledWith(4000, "tick timeout");
    await stop();
  });

  test("keeps the watchdog active for mixed finite and unbounded requests", async () => {
    vi.useFakeTimers();
    const { client, close, stop } = createWatchedGatewayClient();
    const requests = [
      client.request("status", undefined, { timeoutMs: 100 }),
      client.request("chat.send", undefined, { expectFinal: true }),
    ];
    const settlements = Promise.allSettled(requests);

    await vi.advanceTimersByTimeAsync(20);

    expect(close).toHaveBeenCalledWith(4000, "tick timeout");
    await stop();
    await expect(settlements).resolves.toEqual([
      expect.objectContaining({ status: "rejected" }),
      expect.objectContaining({ status: "rejected" }),
    ]);
  });

  test("keeps an unbounded request alive while inbound ticks continue", async () => {
    vi.useFakeTimers();
    const { client, close, send, receive, stop } = createWatchedGatewayClient();
    const request = client.request<{ status: string }>("chat.send", undefined, {
      expectFinal: true,
    });
    const requestFrame = JSON.parse(String(send.mock.calls[0]?.[0])) as { id: string };

    for (let seq = 1; seq <= 4; seq += 1) {
      await vi.advanceTimersByTimeAsync(5);
      receive({ type: "event", event: "tick", seq, payload: {} });
    }

    expect(close).not.toHaveBeenCalled();
    receive({
      type: "res",
      id: requestFrame.id,
      ok: true,
      payload: { status: "ok" },
    });
    await expect(request).resolves.toEqual({ status: "ok" });
    await stop();
  });

  test("clamps oversized tick watchdog intervals before scheduling", () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const { client } = createWatchedGatewayClient(Number.MAX_SAFE_INTEGER);

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), MAX_SAFE_TIMEOUT_DELAY_MS);
    client.stop();
  });

  test("clamps oversized stopAndWait timeouts before scheduling", async () => {
    vi.useFakeTimers();
    const client = new GatewayClient({});
    const ws = { readyState: WebSocket.OPEN, close: vi.fn(), terminate: vi.fn() };
    (client as unknown as { ws: unknown }).ws = ws;
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const stopPromise = client.stopAndWait({ timeoutMs: Number.MAX_SAFE_INTEGER });

    await vi.advanceTimersByTimeAsync(1);
    expect(ws.terminate).not.toHaveBeenCalled();
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_SAFE_TIMEOUT_DELAY_MS);

    await vi.advanceTimersByTimeAsync(249);
    await expect(stopPromise).resolves.toBeUndefined();
    expect(ws.terminate).toHaveBeenCalledTimes(1);
  });
});
