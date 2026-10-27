import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net, { type AddressInfo } from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import tls from "node:tls";
import { createDeferred as deferred } from "openclaw/plugin-sdk/extension-shared";
import {
  PROXY_FIXTURE_CERTIFICATE as RELAY_TEST_TLS_CERT,
  PROXY_FIXTURE_KEY as RELAY_TEST_TLS_KEY,
  useAutoCleanupTempDirTracker,
} from "openclaw/plugin-sdk/test-env";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import { type WebSocket, WebSocketServer } from "openclaw/plugin-sdk/websocket-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SlackSendIdentity } from "../send.js";
import {
  buildRelayWebSocketOptions,
  buildRelayWebSocketUrl,
  monitorSlackRelaySource,
  parseRelayFrame,
  SlackRelayMalformedFrameError,
  SLACK_RELAY_MAX_PAYLOAD_BYTES,
} from "./relay-source.js";

function closeServer(server: http.Server | https.Server | WebSocketServer) {
  return new Promise<void>((resolve, reject) => {
    server.close((error?: Error) => (error ? reject(error) : resolve()));
  });
}

async function listenRelay() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => {
    server.once("listening", resolve);
  });
  return { server, url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/gateway/ws` };
}

async function closeRelay(server: WebSocketServer) {
  for (const client of server.clients) {
    client.terminate();
  }
  await closeServer(server);
}

async function stopProxy(
  monitor: ReturnType<typeof startRelayMonitor>,
  fixture: Awaited<ReturnType<typeof createRelayProxyFixture>>,
  expected?: { name: string },
) {
  const stopped = await monitor.stop();
  await fixture.close();
  expect(stopped).toEqual(expected ? expect.objectContaining(expected) : undefined);
}

const relayUpgrade = (via: "direct" | "proxy") => ({
  via,
  authorization: "Bearer relay-secret",
  url: "/gateway/ws?gateway_id=pash",
  extensions: undefined,
});

function eventFrame(
  deliveryId: string,
  event: { text?: string; user?: string; ts?: string } = { text: "hello" },
  route = { kind: "channel_default", key: "T1:C1" },
) {
  return JSON.stringify({
    type: "slack_event",
    delivery_id: deliveryId,
    route,
    payload: { event: { type: "message", channel: "C1", ts: "1.000001", ...event } },
  });
}

describe("Slack relay source", () => {
  it("builds authenticated relay websocket URLs safely", () => {
    const url = (input: string) =>
      buildRelayWebSocketUrl({ url: input, authToken: "secret", gatewayId: "pash" });
    expect(url("https://router.example.com/gateway/ws?existing=1")).toBe(
      "wss://router.example.com/gateway/ws?existing=1&gateway_id=pash",
    );
    expect(() => url("ws://router.example.com/gateway/ws")).toThrow(
      "plaintext ws:// for non-local host",
    );
    expect(() => url("https://router.example.com")).toThrow("must include its websocket path");

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
    const { server, url } = await listenRelay();
    const ack = deferred<Record<string, unknown>>();
    const acceptStarted = deferred<void>();
    const acceptDone = deferred<void>();
    const receivedAcks: Array<Record<string, unknown>> = [];
    server.once("connection", (socket) => {
      socket.on("message", (data) => {
        const frame = JSON.parse(rawDataToString(data)) as Record<string, unknown>;
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
        eventFrame(
          "delivery-failed",
          { text: "fail-handler" },
          { kind: "user_group", key: "T1:S1" },
        ),
      );
      socket.send(eventFrame("delivery-1"));
    });

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
    const identities: Array<SlackSendIdentity | undefined> = [];
    const statuses: Array<Record<string, unknown>> = [];
    const monitor = startRelayMonitor({ url }, (status) => statuses.push(status), {
      acceptRelayEvent,
      runtime: { error: runtimeError, log: vi.fn(), exit: vi.fn() },
      identityHealth: { lifecycle: "blocked", lastError: "request_timeout" },
      setIdentity: (identity) => identities.push(identity),
    });

    await acceptStarted.promise;
    expect(receivedAcks).toEqual([]);
    acceptDone.resolve();
    await ack.promise;
    expect(receivedAcks).toEqual([{ type: "ack", delivery_id: "delivery-1" }]);
    expect(runtimeError).toHaveBeenCalledTimes(2);
    expect(acceptRelayEvent).toHaveBeenCalledWith({
      deliveryId: "delivery-1",
      message: expect.objectContaining({ channel: "C1", text: "hello" }),
    });
    expect(identities).toContainEqual({
      username: "Nik Team Claw",
      iconUrl: "https://example.com/nik.png",
    });
    expect(statuses).toContainEqual({ relayRoute: { kind: "channel_default", key: "T1:C1" } });
    expect(statuses).toContainEqual({
      connected: true,
      lastConnectedAt: expect.any(Number),
      lifecycle: "blocked",
      lastError: "request_timeout",
    });

    monitor.abortController.abort();
    await monitor.monitor;
    expect(identities.at(-1)).toBeUndefined();
    await closeRelay(server);
  });

  it("settles durable acceptance before recovering from a websocket error", async () => {
    const { server, url } = await listenRelay();
    const connected = deferred<WebSocket>();
    const socketClosed = deferred<void>();
    server.once("connection", (socket) => {
      socket.once("close", () => socketClosed.resolve());
      connected.resolve(socket);
      socket.send(eventFrame("pending-on-error", {}));
    });
    const acceptStarted = deferred<void>();
    const acceptDone = deferred<void>();
    const statuses: Array<Record<string, unknown>> = [];
    const { abortController, stopped } = startRelayMonitor(
      { url },
      (status) => statuses.push(status),
      {
        acceptRelayEvent: async () => {
          acceptStarted.resolve();
          await acceptDone.promise;
        },
      },
    );
    try {
      await acceptStarted.promise;
      const socket = await connected.promise;
      socket.send(Buffer.alloc(SLACK_RELAY_MAX_PAYLOAD_BYTES + 1));
      await socketClosed.promise;
      expect(statuses.filter((status) => status.lifecycle === "recovering")).toEqual([]);
      abortController.abort();
      acceptDone.resolve();
      await expect(stopped).resolves.toBeUndefined();
    } finally {
      abortController.abort();
      acceptDone.resolve();
      await stopped;
      await closeRelay(server);
    }
  });

  it("parseRelayFrame wraps the original SyntaxError as the cause", () => {
    let error: unknown;
    try {
      parseRelayFrame(Buffer.from("NOT JSON {{{", "utf8"));
    } catch (err: unknown) {
      error = err;
    }
    expect(error).toBeInstanceOf(SlackRelayMalformedFrameError);
    expect(error).toMatchObject({
      message: expect.stringContaining("malformed JSON frame"),
      cause: expect.any(SyntaxError),
    });
  });
});

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

async function createRelayProxyFixture(
  options: {
    credentials?: { username: string; password: string };
    tls?: boolean;
    stall?: boolean;
  } = {},
) {
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
  const connects: Array<{
    target?: string;
    authorizationPresent: boolean;
    proxyAuthorization: "missing" | "valid" | "invalid";
  }> = [];
  let relayConnections = 0;
  let proxySecureConnections = 0;
  const connectStarted = deferred<void>();
  const proxyClosed = deferred<void>();
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
      extensions: request.headers["sec-websocket-extensions"],
    });
  });
  const reject = (_request: http.IncomingMessage, response: http.ServerResponse) => {
    response.writeHead(403).end();
  };
  const proxy = options.tls
    ? https.createServer({ key: PROXY_TEST_TLS_KEY, cert: PROXY_TEST_TLS_CERT }, reject)
    : http.createServer(reject);
  proxy.on("connection", track);
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
    clientSocket.once("close", () => proxyClosed.resolve());
    connectStarted.resolve();
    if (options.stall) {
      // CONNECT detaches HTTP's half-close handler; finish after the client aborts.
      clientSocket.once("end", () => clientSocket.end());
      clientSocket.resume();
      return;
    }
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
    proxySecureConnections: () => proxySecureConnections,
    connectStarted: connectStarted.promise,
    proxyClosed: proxyClosed.promise,
    url: `wss://127.0.0.1:${relayPort}/gateway/ws`,
    target: `127.0.0.1:${relayPort}`,
    proxyHost: `127.0.0.1:${proxyPort}`,
    proxyUrl: `http://127.0.0.1:${proxyPort}`,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await closeRelay(relay);
      await closeServer(relayHttps);
      await closeServer(proxy);
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
    socket.send(eventFrame(deliveryId));
  });
  return ack.promise;
}

/** Runs the relay monitor against a fixture; `stopped` settles with the monitor's rejection, if any. */
function startRelayMonitor(
  fixture: { url: string },
  setStatus?: (status: Record<string, unknown>) => void,
  overrides: Partial<Parameters<typeof monitorSlackRelaySource>[0]> = {},
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
    ...overrides,
  });
  const stopped = monitor.catch((error: unknown) => error);
  return {
    acceptRelayEvent,
    abortController,
    monitor,
    stopped,
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

  it.each(["direct", "authenticated", "tls"] as const)(
    "keeps destination auth private and acknowledges via %s",
    async (route) => {
      const fixture = await createRelayProxyFixture({
        tls: route === "tls",
        credentials: route === "authenticated" ? PROXY_TEST_CREDENTIALS : undefined,
      });
      if (route === "tls") {
        const caFile = path.join(tempDirs.make("slack-relay-proxy-ca-"), "proxy-ca.pem");
        fs.writeFileSync(caFile, PROXY_TEST_TLS_CERT, "utf8");
        vi.stubEnv("HTTPS_PROXY", `https://${fixture.proxyHost}`);
        vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "1");
        vi.stubEnv("OPENCLAW_PROXY_CA_FILE", caFile);
      } else if (route === "authenticated") {
        const { username, password } = PROXY_TEST_CREDENTIALS;
        vi.stubEnv("HTTPS_PROXY", `http://${username}:${password}@${fixture.proxyHost}`);
      } else {
        vi.stubEnv("HTTPS_PROXY", fixture.proxyUrl);
        vi.stubEnv("NO_PROXY", "127.0.0.1");
      }
      const ack = expectRelayAck(fixture.relay, "delivery");
      const monitor = startRelayMonitor(fixture);
      try {
        await expect(ack).resolves.toEqual({ type: "ack", delivery_id: "delivery" });
        expect(fixture.connects).toEqual(
          route === "direct"
            ? []
            : [
                {
                  target: fixture.target,
                  authorizationPresent: false,
                  proxyAuthorization: route === "authenticated" ? "valid" : "missing",
                },
              ],
        );
        expect(fixture.upgrades).toEqual([relayUpgrade(route === "direct" ? "direct" : "proxy")]);
        expect(fixture.relayConnections()).toBe(1);
        expect(fixture.proxySecureConnections()).toBe(route === "tls" ? 1 : 0);
      } finally {
        await stopProxy(monitor, fixture);
      }
    },
  );

  it.each(["invalid protocol", "untrusted certificate"] as const)(
    "recovers from %s without connecting directly or sending CONNECT",
    async (failure) => {
      const fixture = await createRelayProxyFixture({ tls: true });
      const untrusted = failure === "untrusted certificate";
      vi.stubEnv(
        "HTTPS_PROXY",
        untrusted ? `https://${fixture.proxyHost}` : "socks5://proxy.example.test:1080",
      );
      vi.stubEnv("OPENCLAW_PROXY_ACTIVE", undefined);
      vi.stubEnv("OPENCLAW_PROXY_CA_FILE", undefined);
      const firstStatus = deferred<Record<string, unknown>>();
      const monitor = startRelayMonitor(fixture, (status) => firstStatus.resolve(status));
      try {
        await expect(firstStatus.promise).resolves.toMatchObject({
          connected: false,
          lifecycle: "recovering",
          lastError: expect.stringContaining(
            untrusted ? "DEPTH_ZERO_SELF_SIGNED_CERT" : "Unsupported proxy protocol",
          ),
        });
        expect(fixture.proxySecureConnections()).toBe(0);
        expect(fixture.connects).toEqual([]);
        expect(fixture.relayConnections()).toBe(0);
        expect(fixture.upgrades).toEqual([]);
      } finally {
        await stopProxy(monitor, fixture, { name: "AbortError" });
      }
    },
  );

  it("aborts a stalled CONNECT without an unhandled socket error", async () => {
    const fixture = await createRelayProxyFixture({ stall: true });
    vi.stubEnv("HTTPS_PROXY", fixture.proxyUrl);
    const monitor = startRelayMonitor(fixture);
    try {
      await fixture.connectStarted;
      monitor.abortController.abort();
      await monitor.monitor;
      await fixture.proxyClosed;
      expect(fixture.upgrades).toEqual([]);
    } finally {
      monitor.abortController.abort();
      await monitor.monitor;
      await fixture.close();
    }
  });

  it(
    "retries a 407 from the proxy with wrong credentials and never reaches the relay",
    { timeout: 15_000 },
    async () => {
      const fixture = await createRelayProxyFixture({ credentials: PROXY_TEST_CREDENTIALS });
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
        await stopProxy(monitor, fixture, { name: "AbortError" });
      }
    },
  );
});
