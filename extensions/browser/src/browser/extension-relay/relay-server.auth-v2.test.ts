import { EventEmitter, once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import { WebSocket, type RawData } from "openclaw/plugin-sdk/websocket-runtime";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { parseStrictJsonObject } from "../../../chrome-extension/modules/strict-json.js";
import {
  createRelayProof,
  randomRelayNonce,
  relayKeyIdFromHex,
  type BrowserRelayAuthChallenge,
} from "./auth-v2-crypto.js";
import {
  BROWSER_RELAY_AUTH_CHALLENGE_PATH as CHALLENGE_PATH,
  BROWSER_RELAY_AUTH_COMPLETE_PATH as COMPLETE_PATH,
  BROWSER_RELAY_CHALLENGE_TTL_MS as CHALLENGE_TTL_MS,
  BROWSER_RELAY_EXTENSION_SUBPROTOCOL as EXTENSION_PROTOCOL,
  BrowserRelayAuthV2Authority,
  getBrowserRelayAuthV2Authority,
  invalidateBrowserRelayAuthV2Authority,
  parseRelayAuthHello,
} from "./auth-v2.js";
import {
  authenticateExtension,
  authenticateRelayHttp,
  maskedFrame,
  RawHttpConnection,
} from "./relay-http.test-support.js";
import {
  authenticateExtensionWebSocket,
  startExtensionRelayServer,
  type ExtensionRelayHandle,
} from "./relay-server.js";

const KEY = "0123456789abcdef".repeat(4);
const SOURCE = "127.0.0.1";
const hello = (tabs: unknown[] = [], userAgent = "test", browserVersion = "Chrome/test") => ({
  type: "hello",
  userAgent,
  browserVersion,
  extensionVersion: "2",
  tabs,
});
const tab = (title: string, tabId = 1, url = "https://example.test", active = true) => ({
  tabId,
  url,
  title,
  active,
});
const authHello = (clientNonce = randomRelayNonce()) => ({
  type: "auth.hello",
  v: 2,
  keyId: relayKeyIdFromHex(KEY),
  clientNonce,
});
const completion = (challenge: BrowserRelayAuthChallenge) => ({
  v: 2,
  sessionId: challenge.sessionId,
  clientProof: createRelayProof(KEY, "client", challenge),
});
const authResponse = (challenge: BrowserRelayAuthChallenge) => ({
  type: "auth.response",
  ...completion(challenge),
});
const httpHello = (clientNonce = randomRelayNonce()) => ({
  v: 2,
  keyId: relayKeyIdFromHex(KEY),
  clientNonce,
  role: "cdp",
  transport: "connection",
  method: "GET",
  resource: "/json/list",
  flow: "json-list",
});
function sendJson(socket: Pick<WebSocket, "send">, value: unknown) {
  socket.send(JSON.stringify(value));
}

function attachTestExtension(handle: ExtensionRelayHandle): void {
  const handlers = handle.bridge.attachExtensionSocket({ send: () => {}, close: () => {} });
  handlers.onMessage(JSON.stringify(hello()));
}

async function messageAfter(socket: WebSocket, action: () => unknown) {
  const pending = once(socket, "message");
  await action();
  const [raw] = (await pending) as [RawData];
  return JSON.parse(rawDataToString(raw)) as Record<string, unknown>;
}

async function openExtensionSocket(
  handle: ExtensionRelayHandle,
  protocols: string | string[],
): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/extension`, protocols, {
    origin: "chrome-extension://relay-auth-v2-test",
  });
  ws.on("error", () => {});
  await once(ws, "open");
  return ws;
}

async function authenticateV2Extension(handle: ExtensionRelayHandle): Promise<WebSocket> {
  const ws = await openExtensionSocket(handle, EXTENSION_PROTOCOL);
  await authenticateExtension(ws, KEY);
  return ws;
}

function createWebSocketAuthHarness(
  options: {
    prepareAuthenticated?: () => Promise<() => void>;
    removePreAuthGuard?: () => void;
  } = {},
) {
  const close = vi.fn();
  const send = vi.fn();
  const socket = Object.assign(new EventEmitter(), {
    close,
    readyState: 1,
    send,
    terminate: vi.fn(),
  }) as unknown as WebSocket;
  const authority = new BrowserRelayAuthV2Authority(KEY);
  const issueChallenge = vi.spyOn(authority, "issueChallenge");
  const prepareAuthenticated = vi.fn(options.prepareAuthenticated ?? (async () => vi.fn()));
  authenticateExtensionWebSocket({
    ws: socket,
    authority,
    source: SOURCE,
    resource: "/extension",
    prepareAuthenticated,
    removePreAuthGuard: options.removePreAuthGuard,
  });
  return { authority, close, issueChallenge, prepareAuthenticated, send, socket };
}

async function sendRawV2Frames(params: {
  port: number;
  subsequentFrames?: Buffer[];
}): Promise<string> {
  const socket = net.createConnection({ host: "127.0.0.1", port: params.port });
  socket.on("error", () => {});
  await once(socket, "connect");
  const received: Buffer[] = [];
  socket.on("data", (chunk) => received.push(Buffer.from(chunk)));
  const closed = once(socket, "close");
  const request = Buffer.from(
    [
      "GET /extension HTTP/1.1",
      "Host: 127.0.0.1",
      "Connection: Upgrade",
      "Upgrade: websocket",
      "Sec-WebSocket-Version: 13",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      `Sec-WebSocket-Protocol: ${EXTENSION_PROTOCOL}`,
      "Origin: chrome-extension://relay-auth-v2-test",
      "",
      "",
    ].join("\r\n"),
  );
  socket.write(request);
  if (params.subsequentFrames?.length) {
    await vi.waitFor(() => {
      expect(Buffer.concat(received).toString("utf8")).toContain("101 Switching Protocols");
    });
    socket.write(Buffer.concat(params.subsequentFrames));
  }
  await closed;
  return Buffer.concat(received).toString("utf8");
}

describe("extension relay WebSocket auth v2 frame boundary", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it.each([
    [
      "oversized Buffer[]",
      [Buffer.alloc(8 * 1024), Buffer.alloc(8 * 1024 + 1)],
      false,
      "browser relay auth frame is too large",
    ],
    ["binary", Buffer.from("{}"), true, "binary browser relay auth frames are not allowed"],
  ] satisfies Array<[string, RawData, boolean, string]>)(
    "rejects a %s auth frame before challenge or promotion",
    (_kind, data, binary, reason) => {
      const f = createWebSocketAuthHarness();
      f.socket.emit("message", data, binary);
      expect(f.close).toHaveBeenCalledWith(4003, reason);
      expect(f.issueChallenge).not.toHaveBeenCalled();
      expect(f.send).not.toHaveBeenCalled();
      expect(f.prepareAuthenticated).not.toHaveBeenCalled();
      f.socket.emit("close");
    },
  );

  it("releases a timed-out pending socket without disturbing active capacity", async () => {
    const removePreAuthGuard = vi.fn();
    const f = createWebSocketAuthHarness({ removePreAuthGuard });
    const activeInvalidated = vi.fn();
    expect(f.authority.registerAuthenticatedConnection({}, activeInvalidated)).toBe(true);
    for (let index = 0; index < 127; index += 1) {
      expect(f.authority.registerPendingConnection({}, vi.fn(), `192.0.2.${index}`)).toBe(true);
    }
    expect(f.authority.registerPendingConnection({}, vi.fn(), SOURCE)).toBe(false);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.close).toHaveBeenCalledWith(4008, "browser relay auth timeout");
    expect(removePreAuthGuard).not.toHaveBeenCalled();
    f.socket.emit("close");
    expect(removePreAuthGuard).toHaveBeenCalledOnce();
    expect(f.authority.registerPendingConnection({}, vi.fn(), SOURCE)).toBe(true);
    expect(activeInvalidated).not.toHaveBeenCalled();
  });

  it("ends the proof deadline at promotion while authenticated preparation remains pending", async () => {
    const attach = vi.fn();
    const preparation = createDeferred<() => void>();
    const removePreAuthGuard = vi.fn();
    const f = createWebSocketAuthHarness({
      prepareAuthenticated: async () => await preparation.promise,
      removePreAuthGuard,
    });
    f.socket.emit("message", Buffer.from(JSON.stringify(authHello())), false);
    const challenge = JSON.parse(f.send.mock.calls[0]?.[0]) as BrowserRelayAuthChallenge;
    f.socket.emit("message", Buffer.from(JSON.stringify(authResponse(challenge))), false);
    expect(removePreAuthGuard).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(CHALLENGE_TTL_MS + 1);
    expect(f.close).not.toHaveBeenCalled();
    expect(f.socket.readyState).toBe(WebSocket.OPEN);

    preparation.resolve(attach);
    await vi.waitFor(() => expect(attach).toHaveBeenCalledOnce());
    expect(f.send.mock.calls.some(([raw]) => JSON.parse(raw).type === "auth.ok")).toBe(true);
    expect(f.close).not.toHaveBeenCalled();
    f.socket.emit("close");
  });
});

describe("extension relay HTTP auth v2", { concurrent: false }, () => {
  let stateDir: string;
  let previousStateDir: string | undefined;
  let handle: ExtensionRelayHandle | null = null;

  async function connect() {
    const connection = await RawHttpConnection.connect(handle!.port);
    onTestFinished(() => connection.close());
    return connection;
  }
  const internalHeaders = () => ({
    Authorization: `Basic ${Buffer.from(`openclaw-internal:${handle!.internalToken}`).toString("base64")}`,
  });
  async function versionStatus(connection: RawHttpConnection) {
    return (await connection.request("GET", "/json/version", "", internalHeaders())).status;
  }

  beforeEach(async () => {
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-relay-auth-v2-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    await fs.mkdir(path.join(stateDir, "credentials"), { recursive: true });
    await fs.writeFile(
      path.join(stateDir, "credentials", "browser-extension-relay.secret"),
      `${KEY}\n`,
      { mode: 0o600 },
    );
    invalidateBrowserRelayAuthV2Authority();
  });

  afterEach(async () => {
    await handle?.close();
    handle = null;
    invalidateBrowserRelayAuthV2Authority();
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("keeps the same-socket CDP upgrade active and rotation-bound", async () => {
    handle = await startExtensionRelayServer({ port: 0, token: KEY, allowLegacyAuth: false });
    attachTestExtension(handle);
    const connection = await connect();
    await authenticateRelayHttp(connection, KEY, "cdp");
    const version = await connection.request("GET", "/json/version");
    expect(version.status).toBe(200);
    expect(JSON.parse(version.body).webSocketDebuggerUrl).toBe(`ws://127.0.0.1:${handle.port}/cdp`);
    const upgraded = await connection.upgrade("/cdp");
    expect(upgraded.status).toBe(101);
    expect(handle.bridge.cdpClientCount).toBe(1);
    const closed = once(connection.socket, "close");
    getBrowserRelayAuthV2Authority("f".repeat(64));
    await closed;
    await vi.waitFor(() => expect(handle?.bridge.cdpClientCount).toBe(0));
  });

  it("closes malformed WebSocket framing before authentication without an unowned error", async () => {
    handle = await startExtensionRelayServer({ port: 0, token: KEY, allowLegacyAuth: false });
    const issueChallenge = vi.spyOn(getBrowserRelayAuthV2Authority(KEY), "issueChallenge");
    // Client frames must be masked. This fails inside ws, before the auth parser.
    const response = await sendRawV2Frames({
      port: handle.port,
      subsequentFrames: [Buffer.from([0x81, 0x00])],
    });
    expect(response).toContain("101 Switching Protocols");
    expect(response).not.toContain("auth.challenge");
    expect(issueChallenge).not.toHaveBeenCalled();
    expect(handle.bridge.extensionConnected).toBe(false);
  });

  it("rejects fragmented masked pre-auth wire overhead before challenge or promotion", async () => {
    const payloadBytes = 16 * 1024;
    const fragmentBytes = 91;
    handle = await startExtensionRelayServer({ port: 0, token: KEY, allowLegacyAuth: false });
    const authority = getBrowserRelayAuthV2Authority(KEY);
    const issueChallenge = vi.spyOn(authority, "issueChallenge");
    const payload = Buffer.from(JSON.stringify(authHello()).padEnd(payloadBytes, " "));
    // Valid JSON padding leaves the wire limit as the fragmented case's rejection owner.
    expect(payload.byteLength).toBe(payloadBytes);
    expect(parseRelayAuthHello(parseStrictJsonObject(payload.toString("utf8"))) !== null).toBe(
      true,
    );
    const fragments: Buffer[] = [];
    for (let offset = 0; offset < payload.length; offset += fragmentBytes) {
      const end = Math.min(offset + fragmentBytes, payload.length);
      fragments.push(
        maskedFrame(payload.subarray(offset, end), {
          fin: end === payload.length,
          opcode: offset === 0 ? 0x1 : 0x0,
        }),
      );
    }
    expect(Buffer.concat(fragments).byteLength).toBe(17_470);
    const response = await sendRawV2Frames({ port: handle.port, subsequentFrames: fragments });

    expect(response).not.toContain("auth.challenge");
    expect(response).not.toContain("auth.ok");
    expect(issueChallenge).not.toHaveBeenCalled();
    expect(handle.bridge.extensionConnected).toBe(false);
  });

  it("keeps the 64 MiB application receiver after v2 authentication", async () => {
    handle = await startExtensionRelayServer({ port: 0, token: KEY, allowLegacyAuth: false });
    const socket = await authenticateV2Extension(handle);
    sendJson(
      socket,
      hello([
        tab("one", 1, `https://example.test/${"a".repeat(16_000)}`),
        tab("two", 2, `https://example.test/${"b".repeat(16_000)}`, false),
      ]),
    );

    await vi.waitFor(() => expect(handle?.bridge.extensionConnected).toBe(true));
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.close();
  });

  it.each(["silent", "responsive"])("tracks authenticated heartbeat: %s", async (mode) => {
    handle = await startExtensionRelayServer({
      port: 0,
      token: KEY,
      allowLegacyAuth: false,
    });
    const extension = await authenticateV2Extension(handle);
    let client: WebSocket | undefined;
    let versionConnection: RawHttpConnection | undefined;
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      sendJson(extension, hello([tab(mode === "silent" ? "one" : "initial")]));
      await vi.waitFor(() => expect(handle?.bridge.extensionConnected).toBe(true));
      if (mode === "responsive") {
        for (let index = 0; index < 4; index += 1) {
          expect(await messageAfter(extension, () => vi.advanceTimersByTimeAsync(20_000))).toEqual({
            type: "ping",
          });
          sendJson(extension, { type: "pong" });
          sendJson(extension, { type: "tabs", tabs: [tab(`beat-${index}`)] });
          await vi.waitFor(() =>
            expect(handle?.bridge.accessibleTabs()[0]?.title).toBe(`beat-${index}`),
          );
        }
        expect(extension.readyState).toBe(WebSocket.OPEN);
        expect(handle.bridge.extensionConnected).toBe(true);
        return;
      }
      client = new WebSocket(`ws://127.0.0.1:${handle.port}/cdp`, { headers: internalHeaders() });
      client.on("error", () => {});
      await once(client, "open");
      const clientFrames: Array<Record<string, unknown>> = [];
      client.on("message", (raw: RawData) => {
        clientFrames.push(JSON.parse(rawDataToString(raw)) as Record<string, unknown>);
      });

      const attachCommand = await messageAfter(extension, () =>
        sendJson(client!, {
          id: 1,
          method: "Target.setAutoAttach",
          params: { autoAttach: true },
        }),
      );
      expect(attachCommand.type).toBe("attach");
      sendJson(extension, {
        type: "result",
        seq: attachCommand.seq,
        result: { targetId: "target-1" },
      });
      await vi.waitFor(() =>
        expect(clientFrames.some((frame) => frame.method === "Target.attachedToTarget")).toBe(true),
      );
      const attached = clientFrames.find((frame) => frame.method === "Target.attachedToTarget");
      const sessionId = (attached?.params as { sessionId?: string } | undefined)?.sessionId;
      expect(typeof sessionId).toBe("string");

      for (let index = 0; index < 2; index += 1) {
        expect(await messageAfter(extension, () => vi.advanceTimersByTimeAsync(20_000))).toEqual({
          type: "ping",
        });
      }
      expect(extension.readyState).toBe(WebSocket.OPEN);

      expect(
        await messageAfter(extension, () =>
          sendJson(client!, { id: 2, sessionId, method: "Page.getFrameTree" }),
        ),
      ).toMatchObject({ type: "cdp", method: "Page.getFrameTree" });

      versionConnection = await connect();
      expect(await versionStatus(versionConnection)).toBe(200);

      const closed = once(extension, "close");
      await vi.advanceTimersByTimeAsync(20_000);
      expect(handle.bridge.extensionConnected).toBe(false);
      await vi.waitFor(() =>
        expect(clientFrames.find((frame) => frame.id === 2)).toMatchObject({
          error: { message: "extension disconnected" },
        }),
      );
      const [code, reason] = (await closed) as [number, Buffer];
      expect([code, reason.toString()]).toEqual([4000, "extension heartbeat timeout"]);

      expect(await versionStatus(versionConnection)).toBe(503);
    } finally {
      versionConnection?.close();
      client?.terminate();
      extension.terminate();
      await handle?.close();
      handle = null;
      vi.useRealTimers();
    }
  });

  it("keeps an active extension at the pending source limit and recovers after release", async () => {
    handle = await startExtensionRelayServer({ port: 0, token: KEY, allowLegacyAuth: true });
    const active = await openExtensionSocket(handle, [
      "openclaw-extension-relay",
      `openclaw-extension-token.${KEY}`,
    ]);
    sendJson(active, hello([]));
    await vi.waitFor(() => expect(handle?.bridge.extensionConnected).toBe(true));

    // Alias equivalence is covered at the authority boundary in auth-v2.test.ts.
    // Real sockets use the configured loopback address on every platform.
    const attacker = await Promise.all(
      Array.from({ length: 32 }, () => openExtensionSocket(handle!, EXTENSION_PROTOCOL)),
    );
    expect(active.readyState).toBe(WebSocket.OPEN);
    expect(handle.bridge.extensionConnected).toBe(true);

    const overflow = new WebSocket(`ws://127.0.0.1:${handle.port}/extension`, EXTENSION_PROTOCOL, {
      origin: "chrome-extension://relay-auth-v2-test",
    });
    overflow.on("error", () => {});
    const overflowClosed = once(overflow, "close");
    await once(overflow, "open");
    const [overflowCode] = (await overflowClosed) as [number, Buffer];
    expect(overflowCode).toBe(4013);
    expect(active.readyState).toBe(WebSocket.OPEN);
    expect(handle.bridge.extensionConnected).toBe(true);

    const released = once(attacker[0]!, "close");
    attacker[0]!.close();
    await released;
    const promoted = await authenticateV2Extension(handle);
    sendJson(promoted, hello([], "test-v2", "Chrome/test-v2"));
    await vi.waitFor(() => expect(handle?.bridge.extensionConnected).toBe(true));

    promoted.close();
    active.close();
    for (const socket of attacker.slice(1)) {
      socket.close();
    }
  }, 30_000);

  it.each(["completion on another socket", "replayed client nonce"])(
    "rejects %s without accepting replay",
    async (replay) => {
      handle = await startExtensionRelayServer({ port: 0, token: KEY });
      const first = await connect();
      const second = await connect();
      const body = JSON.stringify(httpHello());
      const response = await first.request("POST", CHALLENGE_PATH, body);
      expect(response.status).toBe(200);
      if (replay === "replayed client nonce") {
        expect((await second.request("POST", CHALLENGE_PATH, body)).status).toBe(401);
      } else {
        const challenge = JSON.parse(response.body) as BrowserRelayAuthChallenge;
        const proof = JSON.stringify(completion(challenge));
        expect((await second.request("POST", COMPLETE_PATH, proof)).status).toBe(409);
        expect((await first.request("POST", COMPLETE_PATH, proof)).status).toBe(200);
      }
    },
  );

  it("uses a separate one-GET json-list flow and closes it", async () => {
    handle = await startExtensionRelayServer({ port: 0, token: KEY, allowLegacyAuth: false });
    attachTestExtension(handle);
    const connection = await connect();
    await authenticateRelayHttp(connection, KEY, "json-list");
    const list = await connection.request("GET", "/json/list");
    expect(list.status).toBe(200);
    expect(JSON.parse(list.body)).toEqual([]);
    expect(list.headers.connection).toBe("close");
  });

  it("gates K-bearing legacy auth but preserves process-ephemeral internal Basic auth", async () => {
    handle = await startExtensionRelayServer({ port: 0, token: KEY, allowLegacyAuth: false });
    attachTestExtension(handle);
    const bearer = await connect();
    expect(
      (await bearer.request("GET", "/json/version", "", { Authorization: `Bearer ${KEY}` })).status,
    ).toBe(401);

    const query = await connect();
    expect((await query.request("GET", `/json/version?token=${KEY}`)).status).toBe(401);

    const internal = await connect();
    expect(await versionStatus(internal)).toBe(200);
  });

  it("rejects query substitutions and duplicate security fields", async () => {
    handle = await startExtensionRelayServer({ port: 0, token: KEY });
    const query = await connect();
    expect((await query.request("POST", `${CHALLENGE_PATH}?x=1`, JSON.stringify({}))).status).toBe(
      400,
    );

    const duplicate = await connect();
    const nonce = randomRelayNonce();
    const body = `{"v":2,"v":1,"keyId":"${relayKeyIdFromHex(KEY)}","clientNonce":"${nonce}","role":"cdp","transport":"connection","method":"GET","resource":"/json/list","flow":"json-list"}`;
    expect((await duplicate.request("POST", CHALLENGE_PATH, body)).status).toBe(400);
    duplicate.close();
  });
});
