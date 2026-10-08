import { X509Certificate } from "node:crypto";
import { createServer as createHttpServer, type IncomingHttpHeaders } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import {
  connect,
  createServer as createTcpServer,
  type AddressInfo,
  type Server,
  type Socket,
} from "node:net";
import { checkServerIdentity } from "node:tls";
import { installGlobalProxy, type ProxylineHandle } from "@openclaw/proxyline";
import { afterEach, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../../test/helpers/tls-fixture.js";
import { GatewayClient, type GatewayClientCloseInfo } from "./client.js";
import { resolveGatewayWebSocketTransport } from "./websocket-transport.js";
import { WebSocketServer } from "./websocket.test-support.js";

const fingerprint = new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256;
const servers: Server[] = [];
const websocketServers: WebSocketServer[] = [];
const sockets = new Set<Socket>();
let socketDrain = createDeferred();
const clients: GatewayClient[] = [];
let proxy: ProxylineHandle | undefined;

function trackSocket(socket: Socket) {
  if (sockets.size === 0) {
    socketDrain = createDeferred();
  }
  sockets.add(socket);
  socket.once("close", () => {
    sockets.delete(socket);
    if (sockets.size === 0) {
      socketDrain.resolve();
    }
  });
}

async function waitForSocketDrain() {
  // Recheck after waking: a new accepted socket can start another drain generation.
  while (sockets.size > 0) {
    await socketDrain.promise;
  }
}

async function listen(server: Server): Promise<number> {
  servers.push(server);
  server.on("connection", trackSocket);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  return (server.address() as AddressInfo).port;
}

afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.stopAndWait();
  }
  for (const server of websocketServers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
  proxy?.stop();
  proxy = undefined;
  for (const socket of sockets) {
    socket.destroy();
  }
  for (const server of servers.splice(0).toReversed()) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
  await waitForSocketDrain();
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
  const server = createHttpsServer({ key: TEST_TLS_KEY_PEM, cert: TEST_TLS_CERT_PEM });
  let httpBytes = 0;
  let upgrades = 0;
  let headers: IncomingHttpHeaders | undefined;
  server.on("secureConnection", (socket) => {
    socket.on("data", (chunk: Buffer) => {
      httpBytes += chunk.length;
    });
  });
  const wss = new WebSocketServer({ server });
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
  const client = new GatewayClient({
    url: `wss://fixture:synthetic-password@127.0.0.1:${port}`,
    tlsFingerprint: pin,
    deviceIdentity: null,
    edgeAuthHeaders: {
      "X-Test-Edge-Auth": "synthetic-test-edge-token",
      eXpEcT: "100-continue",
    },
    onConnectError: outcome.resolve,
    onClose: (_code, _reason, info) => closed.resolve(info),
  });
  clients.push(client);
  client.start();
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
    expect(httpBytes).toBe(0);
    expect(upgrades).toBe(0);
    expect(await closed.promise).toMatchObject({
      phase: "pre-hello",
      socketOpened: false,
      transportValidated: false,
      connectRequestSent: false,
    });
  }
  expect(tunnels?.() ?? 0).toBe(managed ? 1 : 0);
  await new Promise<void>((resolve) => {
    wss.close(() => resolve());
  });
});

it.each(["timeout", "cancel"])("cleans up a stalled TLS handshake on %s", async (action) => {
  const accepted = createDeferred();
  const server = createTcpServer((socket) => {
    socket.on("data", () => accepted.resolve());
  });
  const port = await listen(server);
  const failed = createDeferred<Error>();
  const client = new GatewayClient({
    url: `wss://127.0.0.1:${port}`,
    tlsFingerprint: fingerprint,
    deviceIdentity: null,
    preauthHandshakeTimeoutMs: 100,
    onConnectError: failed.resolve,
  });
  clients.push(client);
  client.start();
  await accepted.promise;
  if (action === "timeout") {
    await expect(failed.promise).resolves.toMatchObject({
      message: "Opening handshake has timed out",
      code: "ETIMEDOUT",
    });
  }
  await client.stopAndWait();
  await waitForSocketDrain();
});

it("rejects non-empty edge auth headers before a plaintext WebSocket dial", async () => {
  let resolveConnectError: (error: Error) => void = () => {};
  const connectError = new Promise<Error>((resolve) => {
    resolveConnectError = resolve;
  });
  const client = new GatewayClient({
    url: "ws://127.0.0.1:18789",
    edgeAuthHeaders: { "X-Edge-Auth": "test-secret" },
    onConnectError: resolveConnectError,
  });
  client.start();

  await expect(connectError).resolves.toMatchObject({
    message: "edge auth headers require a wss:// Gateway URL",
  });
  client.stop();
});

it("does not follow an edge redirect and redacts its Location URL", async () => {
  let redirected = false;
  const targetHttpsServer = createHttpsServer({ key: TEST_TLS_KEY_PEM, cert: TEST_TLS_CERT_PEM });
  const targetWebSocketServer = new WebSocketServer({ server: targetHttpsServer });
  websocketServers.push(targetWebSocketServer);
  targetWebSocketServer.on("connection", (socket) => {
    redirected = true;
    socket.close();
  });
  const targetPort = await listen(targetHttpsServer);

  const edgeHttpsServer = createHttpsServer({ key: TEST_TLS_KEY_PEM, cert: TEST_TLS_CERT_PEM });
  edgeHttpsServer.on("upgrade", (_request, socket) => {
    socket.end(
      `HTTP/1.1 302 Found\r\nLocation: wss://127.0.0.1:${targetPort}/?access_token=test-token&safe=1\r\nConnection: close\r\n\r\n`,
    );
  });
  const edgePort = await listen(edgeHttpsServer);
  let resolveConnectError: (error: Error) => void = () => {};
  const connectError = new Promise<Error>((resolve) => {
    resolveConnectError = resolve;
  });
  const client = new GatewayClient({
    url: `wss://127.0.0.1:${edgePort}`,
    edgeAuthHeaders: { "X-Edge-Auth": "test-secret" },
    tlsFingerprint: fingerprint,
    onConnectError: resolveConnectError,
  });
  client.start();

  await expect(connectError).resolves.toMatchObject({
    details: {
      reason: "websocket-upgrade-rejected",
      httpStatus: 302,
      location: `wss://127.0.0.1:${targetPort}/?access_token=***&safe=1`,
    },
  });
  expect(redirected).toBe(false);
  await client.stopAndWait();
});
