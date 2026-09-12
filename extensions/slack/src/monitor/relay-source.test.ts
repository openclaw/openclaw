import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net, { type AddressInfo } from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import tls from "node:tls";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import {
  buildRelayWebSocketOptions,
  buildRelayWebSocketUrl,
  monitorSlackRelaySource,
  parseRelayFrame,
  SlackRelayMalformedFrameError,
  SLACK_RELAY_MAX_PAYLOAD_BYTES,
  type SlackRelayIdentity,
} from "./relay-source.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

function relayFrame(text: string): Buffer {
  return Buffer.from(text, "utf8");
}

describe("Slack relay source", () => {
  it("builds authenticated relay websocket URLs safely", () => {
    expect(
      buildRelayWebSocketUrl({
        url: "https://router.example.com/gateway/ws?existing=1",
        authToken: "secret",
        gatewayId: "pash",
      }),
    ).toBe("wss://router.example.com/gateway/ws?existing=1&gateway_id=pash");

    expect(() =>
      buildRelayWebSocketUrl({
        url: "ws://router.example.com/gateway/ws",
        authToken: "secret",
        gatewayId: "pash",
      }),
    ).toThrow("plaintext ws:// for non-local host");
    expect(() =>
      buildRelayWebSocketUrl({
        url: "https://router.example.com",
        authToken: "secret",
        gatewayId: "pash",
      }),
    ).toThrow("must include its websocket path");

    expect(
      buildRelayWebSocketOptions("secret", "wss://router.example.com/gateway/ws?gateway_id=pash"),
    ).toMatchObject({
      headers: { Authorization: "Bearer secret" },
      handshakeTimeout: 30_000,
      maxPayload: SLACK_RELAY_MAX_PAYLOAD_BYTES,
      perMessageDeflate: false,
    });
  });

  it("applies hello identity and acks a routed event only after durable accept", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => {
      server.once("listening", resolve);
    });
    const port = (server.address() as AddressInfo).port;
    const ack = deferred<Record<string, unknown>>();
    const acceptStarted = deferred<void>();
    const acceptDone = deferred<void>();
    const receivedAcks: Array<Record<string, unknown>> = [];
    const requestHeaders = deferred<{ authorization?: string; url?: string }>();
    server.once("connection", (socket, request) => {
      requestHeaders.resolve({
        authorization: request.headers.authorization,
        url: request.url,
      });
      socket.on("message", (data) => {
        const messageText = Array.isArray(data)
          ? Buffer.concat(data).toString("utf8")
          : data instanceof ArrayBuffer
            ? Buffer.from(new Uint8Array(data)).toString("utf8")
            : Buffer.from(data).toString("utf8");
        const frame = JSON.parse(messageText) as Record<string, unknown>;
        receivedAcks.push(frame);
        ack.resolve(frame);
      });
      socket.send(
        JSON.stringify({
          type: "hello",
          gateway_id: "pash",
          slack_identity: {
            username: "Nik Team Claw",
            icon_url: "https://example.com/nik.png",
          },
        }),
      );
      socket.send("not-json");
      socket.send(
        JSON.stringify({
          type: "slack_event",
          delivery_id: "delivery-failed",
          route: { kind: "user_group", key: "T1:S1" },
          payload: {
            event: {
              type: "message",
              channel: "C1",
              user: "U1",
              text: "fail-handler",
              ts: "1.000000",
            },
          },
        }),
      );
      socket.send(
        JSON.stringify({
          type: "slack_event",
          delivery_id: "delivery-1",
          route: { kind: "channel_default", key: "T1:C1" },
          payload: {
            team_id: "T1",
            event_id: "Ev1",
            event: {
              type: "message",
              channel: "C1",
              user: "U1",
              text: "hello",
              ts: "1.000001",
            },
          },
        }),
      );
    });

    const abortController = new AbortController();
    const acceptRelayEvent = vi.fn(
      async (event: { deliveryId: string; message: { text?: string } }) => {
        if (event.message.text === "fail-handler") {
          throw new Error("durable accept failed");
        }
        acceptStarted.resolve();
        await acceptDone.promise;
      },
    );
    const runtimeError = vi.fn();
    const identities: Array<SlackRelayIdentity | undefined> = [];
    const statuses: Array<Record<string, unknown>> = [];
    const monitor = monitorSlackRelaySource({
      config: {
        url: `ws://127.0.0.1:${port}/gateway/ws`,
        authToken: "relay-secret",
        gatewayId: "pash",
      },
      acceptRelayEvent,
      runtime: { error: runtimeError, log: vi.fn(), exit: vi.fn() },
      abortSignal: abortController.signal,
      identityHealth: { lifecycle: "blocked", lastError: "request_timeout" },
      setIdentity: (identity) => identities.push(identity),
      setStatus: (status) => statuses.push(status),
    });

    await expect(requestHeaders.promise).resolves.toEqual({
      authorization: "Bearer relay-secret",
      url: "/gateway/ws?gateway_id=pash",
    });
    await acceptStarted.promise;
    expect(receivedAcks).toEqual([]);
    acceptDone.resolve();
    await expect(ack.promise).resolves.toEqual({
      type: "ack",
      delivery_id: "delivery-1",
    });
    expect(receivedAcks).toEqual([{ type: "ack", delivery_id: "delivery-1" }]);
    expect(runtimeError).toHaveBeenCalledTimes(2);
    expect(acceptRelayEvent).toHaveBeenCalledWith({
      deliveryId: "delivery-1",
      message: expect.objectContaining({ channel: "C1", text: "hello" }),
    });
    // The failed durable accept must never ack: the router redelivers it.
    expect(receivedAcks).not.toContainEqual({ type: "ack", delivery_id: "delivery-failed" });
    expect(identities).toContainEqual({
      username: "Nik Team Claw",
      iconUrl: "https://example.com/nik.png",
    });
    expect(statuses).toContainEqual({
      relayRoute: { kind: "channel_default", key: "T1:C1" },
    });
    expect(statuses).toContainEqual({
      connected: true,
      lastConnectedAt: expect.any(Number),
      lifecycle: "blocked",
      lastError: "request_timeout",
    });

    abortController.abort();
    await monitor;
    expect(identities.at(-1)).toBeUndefined();
    for (const client of server.clients) {
      client.terminate();
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });

  describe("parseRelayFrame", () => {
    it("parses valid JSON frames", () => {
      const frame = parseRelayFrame(
        relayFrame(JSON.stringify({ type: "slack_event", data: { text: "hello" } })),
      );
      expect(frame).toEqual({ type: "slack_event", data: { text: "hello" } });
    });

    it("throws SlackRelayMalformedFrameError for malformed JSON", () => {
      expect(() => parseRelayFrame(relayFrame("NOT JSON {{{"))).toThrow(
        SlackRelayMalformedFrameError,
      );
    });

    it("wraps the original SyntaxError as the cause", () => {
      let error: unknown;
      try {
        parseRelayFrame(relayFrame("NOT JSON {{{"));
      } catch (err: unknown) {
        error = err;
      }
      expect(error).toBeInstanceOf(SlackRelayMalformedFrameError);
      expect((error as SlackRelayMalformedFrameError).message).toContain("malformed JSON frame");
      expect((error as SlackRelayMalformedFrameError).cause).toBeDefined();
    });

    it("parses empty object frames", () => {
      expect(parseRelayFrame(relayFrame("{}"))).toEqual({});
    });

    it("parses array frames", () => {
      expect(parseRelayFrame(relayFrame("[1, 2, 3]"))).toEqual([1, 2, 3]);
    });
  });
});

// Self-signed loopback certificate (SAN: 127.0.0.1, localhost; valid to 2126)
// so the proxied and direct wss:// dials below terminate real TLS on 127.0.0.1.
const RELAY_TEST_TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIBpzCCAUygAwIBAgIUezTxOxdfUphW7GSOPN3w6ppcqe0wCgYIKoZIzj0EAwIw
GzEZMBcGA1UEAwwQc2xhY2stcmVsYXkudGVzdDAgFw0yNjA5MDkxNzUzMzBaGA8y
MTI2MDgxNjE3NTMzMFowGzEZMBcGA1UEAwwQc2xhY2stcmVsYXkudGVzdDBZMBMG
ByqGSM49AgEGCCqGSM49AwEHA0IABKYC/MK+pREkCGg+imE4JGALlFu2aVQP7XJN
Ckezs+JewV/OAxB4RzXVcgSgGKP6USQaDBnoBBEy+34QH2zXtJ2jbDBqMB0GA1Ud
DgQWBBSI3WK70K2Wh3wnN+TdlErOoIKmQzAfBgNVHSMEGDAWgBSI3WK70K2Wh3wn
N+TdlErOoIKmQzAaBgNVHREEEzARgglsb2NhbGhvc3SHBH8AAAEwDAYDVR0TBAUw
AwEB/zAKBggqhkjOPQQDAgNJADBGAiEAphAGvWPFTevL7rEy7dBjoTVAk/oT93Mm
qvz6jsUI73ACIQDLLDdqa0x1RevRJ98Y1vQad1mNK9Yk4Oh6k2HkafQ9tg==
-----END CERTIFICATE-----`;
const RELAY_TEST_TLS_KEY = [
  "-----BEGIN PRIVATE KEY-----", // pragma: allowlist secret
  "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgnzhEeRMhzEsaGPOM",
  "xvBVdxlMJ7ANKKYd4P6pIl1KgpWhRANCAASmAvzCvqURJAhoPophOCRgC5RbtmlU",
  "D+1yTQpHs7PiXsFfzgMQeEc11XIEoBij+lEkGgwZ6AQRMvt+EB9s17Sd",
  "-----END PRIVATE KEY-----",
].join("\n");

const PROXY_ENV_KEYS = [
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "all_proxy",
  "no_proxy",
] as const;

async function createRelayProxyFixture(mode: "tunnel" | "stall" = "tunnel") {
  const sockets = new Set<Duplex>();
  const track = (socket: Duplex) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  };
  const tunneledPorts = new Set<number>();
  const upgrades: Array<{
    via: "proxy" | "direct";
    authorization?: string;
    url?: string;
    extensions?: string;
  }> = [];
  const connects: Array<{ target?: string; authorizationPresent: boolean }> = [];
  const connectStarted = deferred<void>();
  const proxyClosed = deferred<void>();
  const relayHttps = https.createServer({ key: RELAY_TEST_TLS_KEY, cert: RELAY_TEST_TLS_CERT });
  relayHttps.on("connection", track);
  const relay = new WebSocketServer({ server: relayHttps, path: "/gateway/ws" });
  relay.on("connection", (_socket, request) => {
    upgrades.push({
      via: tunneledPorts.has(request.socket.remotePort ?? -1) ? "proxy" : "direct",
      authorization: request.headers.authorization,
      url: request.url,
      extensions: request.headers["sec-websocket-extensions"],
    });
  });
  const proxy = http.createServer((_request, response) => {
    response.writeHead(403).end();
  });
  proxy.on("connection", track);
  proxy.on("connect", (request, clientSocket, head) => {
    connects.push({
      target: request.url,
      authorizationPresent: Boolean(request.headers.authorization),
    });
    clientSocket.once("close", () => proxyClosed.resolve());
    connectStarted.resolve();
    if (mode === "stall") {
      // CONNECT detaches HTTP's half-close handler; finish after the client aborts.
      clientSocket.once("end", () => clientSocket.end());
      clientSocket.resume();
      return;
    }
    const target = new URL(`http://${request.url}`);
    const targetSocket = net.connect(Number(target.port), target.hostname, () => {
      tunneledPorts.add(targetSocket.localPort ?? -1);
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) {
        targetSocket.write(head);
      }
      clientSocket.pipe(targetSocket);
      targetSocket.pipe(clientSocket);
    });
    track(targetSocket);
    targetSocket.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => targetSocket.destroy());
    clientSocket.on("close", () => targetSocket.destroy());
  });
  const listen = (server: http.Server | https.Server) =>
    new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
    });
  const relayPort = await listen(relayHttps);
  const proxyPort = await listen(proxy);
  return {
    relay,
    upgrades,
    connects,
    connectStarted: connectStarted.promise,
    proxyClosed: proxyClosed.promise,
    url: `wss://127.0.0.1:${relayPort}/gateway/ws`,
    target: `127.0.0.1:${relayPort}`,
    proxyUrl: `http://127.0.0.1:${proxyPort}`,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      for (const client of relay.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve) => {
        relay.close(() => resolve());
      });
      await new Promise<void>((resolve) => {
        relayHttps.close(() => resolve());
      });
      await new Promise<void>((resolve) => {
        proxy.close(() => resolve());
      });
    },
  };
}

// Second self-signed loopback certificate for an https:// proxy hop. It is never
// added to the default CA store, so trust for the proxy can only come from the
// managed-proxy CA file.
const PROXY_TEST_TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIBtTCCAVugAwIBAgIUN8NgmbHQwympZgnlu0iBZS3MF7EwCgYIKoZIzj0EAwIw
ITEfMB0GA1UEAwwWc2xhY2stcmVsYXktcHJveHkudGVzdDAgFw0yNjA5MTAxNzI1
MDJaGA8yMTI2MDgxNzE3MjUwMlowITEfMB0GA1UEAwwWc2xhY2stcmVsYXktcHJv
eHkudGVzdDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABDKtZlDF6UbLFOIY6bxd
mri83ylDIKS6A7hkd4l+rug8b4gWPMyhSp1CFXP1hjBPGtLV729x+BZz8Uja3hKu
8Q+jbzBtMB0GA1UdDgQWBBQi9VQMcgWKV/XyG88d+DbNTYBChTAfBgNVHSMEGDAW
gBQi9VQMcgWKV/XyG88d+DbNTYBChTAaBgNVHREEEzARgglsb2NhbGhvc3SHBH8A
AAEwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNIADBFAiEA41GXetcy2kD9
KRex7/5RE+NU0dPOL/O8CRHwb+E3wxgCIFDhc4Vg3fcHr5ikIEP/MoPmW3bzY6Zr
JsM7IY73LbvH
-----END CERTIFICATE-----`;
const PROXY_TEST_TLS_KEY = [
  "-----BEGIN PRIVATE KEY-----", // pragma: allowlist secret
  "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgfNkHctgW5/YMXhIV",
  "IsfB7B4SdGLfJ29gyMPdKS42FsyhRANCAAQyrWZQxelGyxTiGOm8XZq4vN8pQyCk",
  "ugO4ZHeJfq7oPG+IFjzMoUqdQhVz9YYwTxrS1e9vcfgWc/FI2t4SrvEP",
  "-----END PRIVATE KEY-----",
].join("\n");

const PROXY_TEST_CREDENTIALS = { username: "relay-user", password: "relay-pass" };

/**
 * Relay plus a CONNECT proxy that can require Basic credentials (407 otherwise)
 * and terminate TLS itself. Same relay side as createRelayProxyFixture; the
 * proxy additionally records the Proxy-Authorization outcome and TCP/TLS counts.
 */
async function createRelayGatedProxyFixture(options: {
  credentials?: { username: string; password: string };
  tls?: boolean;
}) {
  const sockets = new Set<Duplex>();
  const track = (socket: Duplex) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  };
  const tunneledPorts = new Set<number>();
  const upgrades: Array<{ via: "proxy" | "direct"; authorization?: string; url?: string }> = [];
  const connects: Array<{
    target?: string;
    authorizationPresent: boolean;
    proxyAuthorization: "missing" | "valid" | "invalid";
  }> = [];
  let relayConnections = 0;
  let proxyConnections = 0;
  let proxySecureConnections = 0;
  const expectedProxyAuthorization = options.credentials
    ? `Basic ${Buffer.from(`${options.credentials.username}:${options.credentials.password}`).toString("base64")}`
    : undefined;
  const relayHttps = https.createServer({ key: RELAY_TEST_TLS_KEY, cert: RELAY_TEST_TLS_CERT });
  relayHttps.on("connection", (socket) => {
    relayConnections += 1;
    track(socket);
  });
  const relay = new WebSocketServer({ server: relayHttps, path: "/gateway/ws" });
  relay.on("connection", (_socket, request) => {
    upgrades.push({
      via: tunneledPorts.has(request.socket.remotePort ?? -1) ? "proxy" : "direct",
      authorization: request.headers.authorization,
      url: request.url,
    });
  });
  const reject = (_request: http.IncomingMessage, response: http.ServerResponse) => {
    response.writeHead(403).end();
  };
  const proxy = options.tls
    ? https.createServer({ key: PROXY_TEST_TLS_KEY, cert: PROXY_TEST_TLS_CERT }, reject)
    : http.createServer(reject);
  proxy.on("connection", (socket) => {
    proxyConnections += 1;
    track(socket);
  });
  proxy.on("secureConnection", () => {
    proxySecureConnections += 1;
  });
  proxy.on("connect", (request, clientSocket, head) => {
    track(clientSocket);
    const header = request.headers["proxy-authorization"];
    const proxyAuthorization =
      header === undefined
        ? "missing"
        : header === expectedProxyAuthorization
          ? "valid"
          : "invalid";
    connects.push({
      target: request.url,
      authorizationPresent: Boolean(request.headers.authorization),
      proxyAuthorization,
    });
    if (expectedProxyAuthorization !== undefined && proxyAuthorization !== "valid") {
      clientSocket.end(
        "HTTP/1.1 407 Proxy Authentication Required\r\n" +
          'Proxy-Authenticate: Basic realm="relay"\r\n' +
          "Connection: close\r\n\r\n",
      );
      return;
    }
    const target = new URL(`http://${request.url}`);
    const targetSocket = net.connect(Number(target.port), target.hostname, () => {
      tunneledPorts.add(targetSocket.localPort ?? -1);
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) {
        targetSocket.write(head);
      }
      clientSocket.pipe(targetSocket);
      targetSocket.pipe(clientSocket);
    });
    track(targetSocket);
    targetSocket.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => targetSocket.destroy());
    clientSocket.on("close", () => targetSocket.destroy());
  });
  const listen = (server: http.Server | https.Server) =>
    new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
    });
  const relayPort = await listen(relayHttps);
  const proxyPort = await listen(proxy);
  return {
    relay,
    upgrades,
    connects,
    relayConnections: () => relayConnections,
    proxyConnections: () => proxyConnections,
    proxySecureConnections: () => proxySecureConnections,
    url: `wss://127.0.0.1:${relayPort}/gateway/ws`,
    target: `127.0.0.1:${relayPort}`,
    proxyHost: `127.0.0.1:${proxyPort}`,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      for (const client of relay.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve) => {
        relay.close(() => resolve());
      });
      await new Promise<void>((resolve) => {
        relayHttps.close(() => resolve());
      });
      await new Promise<void>((resolve) => {
        proxy.close(() => resolve());
      });
    },
  };
}

/** Greets the next relay connection with hello plus one routed event; resolves with its ack. */
function expectRelayAck(relay: WebSocketServer, deliveryId: string): Promise<unknown> {
  const ack = deferred<unknown>();
  relay.once("connection", (socket) => {
    socket.on("message", (data) => {
      ack.resolve(JSON.parse(rawDataToString(data)));
    });
    socket.send(JSON.stringify({ type: "hello", slack_identity: { username: "Relay Proof" } }));
    socket.send(
      JSON.stringify({
        type: "slack_event",
        delivery_id: deliveryId,
        route: { kind: "channel_default", key: "T1:C1" },
        payload: { event: { type: "message", channel: "C1", text: "hello", ts: "1.000001" } },
      }),
    );
  });
  return ack.promise;
}

/** Runs the relay monitor against a fixture; `stopped` settles with the monitor's rejection, if any. */
function startRelayMonitor(
  fixture: { url: string },
  setStatus?: (status: Record<string, unknown>) => void,
) {
  const abortController = new AbortController();
  const acceptRelayEvent = vi.fn(async () => {});
  const monitor = monitorSlackRelaySource({
    config: { url: fixture.url, authToken: "relay-secret", gatewayId: "pash" },
    acceptRelayEvent,
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    identityHealth: { lifecycle: "ready", lastError: null },
    abortSignal: abortController.signal,
    setStatus,
  });
  const stopped = monitor.then(
    () => undefined,
    (error: unknown) => error,
  );
  return {
    acceptRelayEvent,
    stop: async () => {
      abortController.abort();
      return await stopped;
    },
  };
}

describe("Slack relay proxy environment", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let originalCertificates: string[];

  beforeEach(() => {
    for (const key of PROXY_ENV_KEYS) {
      vi.stubEnv(key, undefined);
    }
    originalCertificates = tls.getCACertificates("default");
    tls.setDefaultCACertificates([...originalCertificates, RELAY_TEST_TLS_CERT]);
  });

  afterEach(() => {
    tls.setDefaultCACertificates(originalCertificates);
    vi.unstubAllEnvs();
  });

  it.each([false, true])(
    "delivers through the monitor with destination-only auth and durable acknowledgement (NO_PROXY=%s)",
    async (bypass) => {
      const fixture = await createRelayProxyFixture();
      vi.stubEnv("HTTPS_PROXY", fixture.proxyUrl);
      if (bypass) {
        vi.stubEnv("NO_PROXY", "127.0.0.1");
      }
      const accepted = deferred<void>();
      const releaseAcceptance = deferred<void>();
      const ack = deferred<unknown>();
      const receivedAcks: unknown[] = [];
      const identities: Array<SlackRelayIdentity | undefined> = [];
      const acceptRelayEvent = vi.fn(async () => {
        accepted.resolve();
        await releaseAcceptance.promise;
      });
      fixture.relay.once("connection", (socket) => {
        socket.on("message", (data) => {
          const frame: unknown = JSON.parse(rawDataToString(data));
          receivedAcks.push(frame);
          ack.resolve(frame);
        });
        socket.send(JSON.stringify({ type: "hello", slack_identity: { username: "Relay Proof" } }));
        socket.send(
          JSON.stringify({
            type: "slack_event",
            delivery_id: "proxied-delivery",
            route: { kind: "channel_default", key: "T1:C1" },
            payload: { event: { type: "message", channel: "C1", text: "hello", ts: "1.000001" } },
          }),
        );
      });
      const abortController = new AbortController();
      const monitor = monitorSlackRelaySource({
        config: { url: fixture.url, authToken: "relay-secret", gatewayId: "pash" },
        acceptRelayEvent,
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        identityHealth: { lifecycle: "ready", lastError: null },
        abortSignal: abortController.signal,
        setIdentity: (identity) => identities.push(identity),
      });
      try {
        await accepted.promise;
        expect(fixture.connects).toEqual(
          bypass ? [] : [{ target: fixture.target, authorizationPresent: false }],
        );
        expect(fixture.upgrades).toEqual([
          {
            via: bypass ? "direct" : "proxy",
            authorization: "Bearer relay-secret",
            url: "/gateway/ws?gateway_id=pash",
            extensions: undefined,
          },
        ]);
        expect(acceptRelayEvent).toHaveBeenCalledWith({
          deliveryId: "proxied-delivery",
          message: expect.objectContaining({ channel: "C1", text: "hello" }),
        });
        expect(receivedAcks).toEqual([]);
        releaseAcceptance.resolve();
        await expect(ack.promise).resolves.toEqual({
          type: "ack",
          delivery_id: "proxied-delivery",
        });
        expect(identities).toContainEqual({ username: "Relay Proof" });
      } finally {
        releaseAcceptance.resolve();
        abortController.abort();
        await monitor;
        await fixture.close();
      }
      expect(identities.at(-1)).toBeUndefined();
    },
  );

  it("reports invalid proxy configuration without a direct relay connection", async () => {
    const fixture = await createRelayProxyFixture();
    vi.stubEnv("HTTPS_PROXY", "socks5://proxy.example.test:1080");
    const firstStatus = deferred<Record<string, unknown>>();
    const abortController = new AbortController();
    const monitor = monitorSlackRelaySource({
      config: { url: fixture.url, authToken: "relay-secret", gatewayId: "pash" },
      acceptRelayEvent: vi.fn(async () => {}),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      identityHealth: { lifecycle: "ready", lastError: null },
      abortSignal: abortController.signal,
      setStatus: (status) => firstStatus.resolve(status),
    });
    const stopped = monitor.then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await expect(firstStatus.promise).resolves.toMatchObject({
        connected: false,
        lifecycle: "recovering",
        lastError: expect.stringContaining("Unsupported proxy protocol"),
      });
      expect(fixture.upgrades).toEqual([]);
    } finally {
      abortController.abort();
      await stopped;
      await fixture.close();
    }
    expect(await stopped).toMatchObject({ name: "AbortError" });
  });

  it("aborts a stalled CONNECT without an unhandled socket error", async () => {
    const fixture = await createRelayProxyFixture("stall");
    vi.stubEnv("HTTPS_PROXY", fixture.proxyUrl);
    const abortController = new AbortController();
    const monitor = monitorSlackRelaySource({
      config: { url: fixture.url, authToken: "relay-secret", gatewayId: "pash" },
      acceptRelayEvent: vi.fn(async () => {}),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      identityHealth: { lifecycle: "ready", lastError: null },
      abortSignal: abortController.signal,
    });
    try {
      await fixture.connectStarted;
      abortController.abort();
      await monitor;
      await fixture.proxyClosed;
      expect(fixture.upgrades).toEqual([]);
    } finally {
      abortController.abort();
      await monitor;
      await fixture.close();
    }
  });

  it("sends proxy URL credentials as Proxy-Authorization and acks through the tunnel", async () => {
    const fixture = await createRelayGatedProxyFixture({ credentials: PROXY_TEST_CREDENTIALS });
    vi.stubEnv(
      "HTTPS_PROXY",
      `http://${PROXY_TEST_CREDENTIALS.username}:${PROXY_TEST_CREDENTIALS.password}@${fixture.proxyHost}`,
    );
    const ack = expectRelayAck(fixture.relay, "authenticated-delivery");
    const monitor = startRelayMonitor(fixture);
    try {
      await expect(ack).resolves.toEqual({ type: "ack", delivery_id: "authenticated-delivery" });
      expect(fixture.connects).toEqual([
        { target: fixture.target, authorizationPresent: false, proxyAuthorization: "valid" },
      ]);
      expect(fixture.relayConnections()).toBe(1);
      expect(fixture.upgrades).toEqual([
        { via: "proxy", authorization: "Bearer relay-secret", url: "/gateway/ws?gateway_id=pash" },
      ]);
      expect(monitor.acceptRelayEvent).toHaveBeenCalledTimes(1);
    } finally {
      const stopped = await monitor.stop();
      await fixture.close();
      expect(stopped).toBeUndefined();
    }
  });

  it(
    "retries a 407 from the proxy with wrong credentials and never reaches the relay",
    { timeout: 15_000 },
    async () => {
      const fixture = await createRelayGatedProxyFixture({ credentials: PROXY_TEST_CREDENTIALS });
      vi.stubEnv(
        "HTTPS_PROXY",
        `http://${PROXY_TEST_CREDENTIALS.username}:wrong-pass@${fixture.proxyHost}`,
      );
      const disconnects: Array<Record<string, unknown>> = [];
      const secondDisconnect = deferred<void>();
      const monitor = startRelayMonitor(fixture, (status) => {
        if (status.connected === false) {
          disconnects.push(status);
          if (disconnects.length === 2) {
            secondDisconnect.resolve();
          }
        }
      });
      try {
        // The second disconnect is the backoff retry after the first 407.
        await secondDisconnect.promise;
        expect(fixture.connects).toEqual([
          { target: fixture.target, authorizationPresent: false, proxyAuthorization: "invalid" },
          { target: fixture.target, authorizationPresent: false, proxyAuthorization: "invalid" },
        ]);
        for (const status of disconnects) {
          expect(status).toMatchObject({
            lifecycle: "recovering",
            lastError: expect.stringContaining("HTTP/1.1 407 Proxy Authentication Required"),
          });
        }
        expect(fixture.relayConnections()).toBe(0);
        expect(fixture.upgrades).toEqual([]);
        expect(monitor.acceptRelayEvent).not.toHaveBeenCalled();
      } finally {
        const stopped = await monitor.stop();
        await fixture.close();
        expect(stopped).toMatchObject({ name: "AbortError" });
      }
    },
  );

  it("keeps a NO_PROXY match direct when the proxy URL carries credentials", async () => {
    const fixture = await createRelayGatedProxyFixture({ credentials: PROXY_TEST_CREDENTIALS });
    vi.stubEnv(
      "HTTPS_PROXY",
      `http://${PROXY_TEST_CREDENTIALS.username}:${PROXY_TEST_CREDENTIALS.password}@${fixture.proxyHost}`,
    );
    vi.stubEnv("NO_PROXY", "127.0.0.1");
    const ack = expectRelayAck(fixture.relay, "bypassed-delivery");
    const monitor = startRelayMonitor(fixture);
    try {
      await expect(ack).resolves.toEqual({ type: "ack", delivery_id: "bypassed-delivery" });
      expect(fixture.proxyConnections()).toBe(0);
      expect(fixture.connects).toEqual([]);
      expect(fixture.upgrades).toEqual([
        { via: "direct", authorization: "Bearer relay-secret", url: "/gateway/ws?gateway_id=pash" },
      ]);
    } finally {
      const stopped = await monitor.stop();
      await fixture.close();
      expect(stopped).toBeUndefined();
    }
  });

  it("dials an https:// proxy over TLS trusted through the managed-proxy CA file", async () => {
    const fixture = await createRelayGatedProxyFixture({ tls: true });
    const caDir = tempDirs.make("slack-relay-proxy-ca-");
    const caFile = path.join(caDir, "proxy-ca.pem");
    fs.writeFileSync(caFile, PROXY_TEST_TLS_CERT, "utf8");
    vi.stubEnv("HTTPS_PROXY", `https://${fixture.proxyHost}`);
    vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "1");
    vi.stubEnv("OPENCLAW_PROXY_CA_FILE", caFile);
    const ack = expectRelayAck(fixture.relay, "tls-proxied-delivery");
    const monitor = startRelayMonitor(fixture);
    try {
      await expect(ack).resolves.toEqual({ type: "ack", delivery_id: "tls-proxied-delivery" });
      expect(fixture.proxySecureConnections()).toBe(1);
      expect(fixture.connects).toEqual([
        { target: fixture.target, authorizationPresent: false, proxyAuthorization: "missing" },
      ]);
      expect(fixture.upgrades).toEqual([
        { via: "proxy", authorization: "Bearer relay-secret", url: "/gateway/ws?gateway_id=pash" },
      ]);
    } finally {
      const stopped = await monitor.stop();
      await fixture.close();
      expect(stopped).toBeUndefined();
    }
  });

  it("rejects an untrusted https:// proxy certificate before sending CONNECT", async () => {
    const fixture = await createRelayGatedProxyFixture({ tls: true });
    vi.stubEnv("HTTPS_PROXY", `https://${fixture.proxyHost}`);
    vi.stubEnv("OPENCLAW_PROXY_ACTIVE", undefined);
    vi.stubEnv("OPENCLAW_PROXY_CA_FILE", undefined);
    const firstStatus = deferred<Record<string, unknown>>();
    const monitor = startRelayMonitor(fixture, (status) => firstStatus.resolve(status));
    try {
      await expect(firstStatus.promise).resolves.toMatchObject({
        connected: false,
        lifecycle: "recovering",
        lastError: expect.stringContaining("DEPTH_ZERO_SELF_SIGNED_CERT"),
      });
      expect(fixture.proxyConnections()).toBe(1);
      expect(fixture.proxySecureConnections()).toBe(0);
      expect(fixture.connects).toEqual([]);
      expect(fixture.relayConnections()).toBe(0);
      expect(fixture.upgrades).toEqual([]);
    } finally {
      const stopped = await monitor.stop();
      await fixture.close();
      expect(stopped).toMatchObject({ name: "AbortError" });
    }
  });
});
