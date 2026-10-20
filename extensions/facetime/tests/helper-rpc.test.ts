import { createHmac } from "node:crypto";
import { once } from "node:events";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FaceTimeHelperUnavailableError } from "../src/helper-results.js";
import { FaceTimeHelperSocketServer } from "../src/helper-rpc.js";

const TEST_HELPER_AUTH_TOKEN = "a".repeat(64);
const TEST_HELPER_BUILD_ID = "b".repeat(64);

type TestHelperSession = {
  connectionEpoch: string;
  connectionKey: string;
  incomingSequence: number;
  outgoingSequence: number;
};

const helperSessions = new WeakMap<net.Socket, TestHelperSession>();

function hmac(key: string, message: string): string {
  return createHmac("sha256", key).update(message).digest("hex");
}

function writeFrame(socket: net.Socket, payload: Record<string, unknown>) {
  socket.write(`${JSON.stringify(payload)}\r\n`);
}

async function readFrame(socket: net.Socket): Promise<Record<string, unknown>> {
  const [chunk] = await once(socket, "data");
  return JSON.parse(String(chunk).trim()) as Record<string, unknown>;
}

function waitForSocketEvent(socket: net.Socket, event: "close" | "connect"): Promise<void> {
  return new Promise((resolve) => {
    socket.once(event, () => resolve());
  });
}

async function readHelperPayload(socket: net.Socket): Promise<Record<string, unknown>> {
  const session = helperSessions.get(socket);
  if (!session) {
    throw new Error("test helper is not authenticated");
  }
  const envelope = await readFrame(socket);
  const sequence = Number(envelope.sequence);
  const payloadJson = String(envelope.payload_json);
  expect(envelope).toMatchObject({
    connection_epoch: session.connectionEpoch,
    direction: "server-to-helper",
    sequence: session.incomingSequence + 1,
  });
  expect(envelope.auth).toBe(
    hmac(
      session.connectionKey,
      `message\nserver-to-helper\n${session.connectionEpoch}\n${sequence}\n${payloadJson}`,
    ),
  );
  session.incomingSequence = sequence;
  return JSON.parse(payloadJson) as Record<string, unknown>;
}

function encodeHelperPayload(socket: net.Socket, payload: Record<string, unknown>): string {
  const session = helperSessions.get(socket);
  if (!session) {
    throw new Error("test helper is not authenticated");
  }
  const sequence = session.outgoingSequence + 1;
  const payloadJson = JSON.stringify(payload);
  session.outgoingSequence = sequence;
  return `${JSON.stringify({
    connection_epoch: session.connectionEpoch,
    sequence,
    direction: "helper-to-server",
    payload_json: payloadJson,
    auth: hmac(
      session.connectionKey,
      `message\nhelper-to-server\n${session.connectionEpoch}\n${sequence}\n${payloadJson}`,
    ),
  })}\r\n`;
}

function sendHelperPayload(socket: net.Socket, payload: Record<string, unknown>): void {
  socket.write(encodeHelperPayload(socket, payload));
}

async function exchange<T>(
  client: net.Socket,
  send: () => Promise<T>,
  expected: Record<string, unknown>,
  reply: Record<string, unknown>,
) {
  const received = readHelperPayload(client);
  const result = send();
  const payload = await received;
  expect(payload).toMatchObject(expected);
  expect(typeof payload.transactionId).toBe("string");
  sendHelperPayload(client, { transactionId: payload.transactionId, ...reply });
  return { result, payload };
}

const dialRequest = { handle: "owner@example.com", mode: "audio" as const };
const requestedAt = "2026-07-20T17:52:00.000Z";

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error("timed out waiting for condition");
}

async function registerHelper(
  socket: net.Socket,
  helper: FaceTimeHelperSocketServer,
  bundleIdentifier: string,
  buildId = TEST_HELPER_BUILD_ID,
  expectConnected = true,
  processId = 1234,
): Promise<TestHelperSession | undefined> {
  const processStartedAtMs = 1_700_000_000_000;
  const clientNonce = "c".repeat(64);
  writeFrame(socket, {
    event: "client-hello",
    bundle_identifier: bundleIdentifier,
    build_id: buildId,
    process_id: processId,
    process_started_at_ms: processStartedAtMs,
    client_nonce: clientNonce,
    proof: hmac(
      TEST_HELPER_AUTH_TOKEN,
      `client-hello\n${bundleIdentifier}\n${buildId}\n${processId}\n${processStartedAtMs}\n${clientNonce}`,
    ),
  });
  if (!expectConnected) {
    return undefined;
  }
  const serverHello = await readFrame(socket);
  const serverNonce = String(serverHello.server_nonce);
  const connectionEpoch = String(serverHello.connection_epoch);
  const context = `${bundleIdentifier}\n${buildId}\n${processId}\n${processStartedAtMs}\n${clientNonce}\n${serverNonce}\n${connectionEpoch}`;
  expect(serverHello).toMatchObject({
    event: "server-hello",
    client_nonce: clientNonce,
    proof: hmac(TEST_HELPER_AUTH_TOKEN, `server-hello\n${context}`),
  });
  const connectionKey = hmac(TEST_HELPER_AUTH_TOKEN, `session\n${context}`);
  writeFrame(socket, {
    event: "client-finish",
    connection_epoch: connectionEpoch,
    proof: hmac(connectionKey, `client-finish\n${connectionEpoch}`),
  });
  const session = {
    connectionEpoch,
    connectionKey,
    incomingSequence: 0,
    outgoingSequence: 0,
  };
  helperSessions.set(socket, session);
  await expect(readHelperPayload(socket)).resolves.toEqual({ event: "session-ready" });
  expect(helper.connectedHelperBundles).not.toContain(bundleIdentifier);
  sendHelperPayload(socket, { event: "session-ready-ack" });
  await waitFor(() => helper.connectedHelperBundles.includes(bundleIdentifier));
  return session;
}

describe("FaceTime helper RPC", () => {
  let helper: FaceTimeHelperSocketServer | undefined;
  const clients = new Set<net.Socket>();

  async function startDefaultHelper(
    overrides: Partial<ConstructorParameters<typeof FaceTimeHelperSocketServer>[0]> = {},
  ): Promise<{ rpc: FaceTimeHelperSocketServer; port: number }> {
    // Observe the real listener so its ephemeral port stays bound until helper.stop().
    const createServer = vi.spyOn(net, "createServer");
    let listener: net.Server;
    let rpc: FaceTimeHelperSocketServer;
    try {
      rpc = new FaceTimeHelperSocketServer({
        host: "127.0.0.1",
        port: 0,
        logger: console,
        ipcKey: TEST_HELPER_AUTH_TOKEN,
        buildId: TEST_HELPER_BUILD_ID,
        onMessage: () => undefined,
        ...overrides,
      });
      helper = rpc;
      const created = createServer.mock.results[0];
      if (created?.type !== "return") {
        throw new Error("helper did not create its TCP listener");
      }
      listener = created.value;
    } finally {
      createServer.mockRestore();
    }
    await rpc.start();
    const address = listener.address();
    if (!address || typeof address === "string") {
      throw new Error("helper did not bind a TCP port");
    }
    return { rpc, port: address.port };
  }

  async function connectClient(port: number): Promise<net.Socket> {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    clients.add(socket);
    socket.setEncoding("utf8");
    await waitForSocketEvent(socket, "connect");
    return socket;
  }

  async function connectHelper(
    rpc: FaceTimeHelperSocketServer,
    port: number,
    bundle = "com.apple.FaceTime",
    processId = 1234,
  ) {
    const client = await connectClient(port);
    await registerHelper(client, rpc, bundle, TEST_HELPER_BUILD_ID, true, processId);
    return client;
  }

  async function startConnectedHelper() {
    const { rpc, port } = await startDefaultHelper();
    const client = await connectHelper(rpc, port);
    return { rpc, client };
  }

  afterEach(async () => {
    for (const socket of clients) {
      socket.destroy();
    }
    await helper?.stop();
    clients.clear();
    helper = undefined;
  });

  it("sends set-muted actions over newline-framed JSON and resolves acknowledgements", async () => {
    const { rpc, client } = await startConnectedHelper();
    const { result, payload } = await exchange(
      client,
      () => rpc.setMuted("call-1", false),
      { action: "set-muted", data: { callUUID: "call-1", muted: false } },
      {
        conversation_audio_started: true,
        helperPeer: { processId: 9999 },
        helperBundleIdentifier: "untrusted-payload",
        helperResults: [{ found: false }],
        helpersContacted: 99,
        topologyGeneration: 99,
        topologyComplete: false,
      },
    );
    await expect(result).resolves.toMatchObject({
      transactionId: payload.transactionId,
      conversation_audio_started: true,
      helperPeer: { processId: 1234 },
      helperBundleIdentifier: "com.apple.FaceTime",
      helpersContacted: 1,
      topologyGeneration: 1,
      topologyComplete: true,
      helperResults: [
        expect.objectContaining({
          conversation_audio_started: true,
          helperPeer: expect.objectContaining({ processId: 1234 }),
        }),
      ],
    });
  });

  it.each([
    ["answerCall", "answer-call"],
    ["leaveCall", "leave-call"],
  ] as const)("fans %s out to FaceTime and Phone helpers", async (method, action) => {
    const { rpc, port } = await startDefaultHelper();

    const faceTimeClient = await connectHelper(rpc, port);
    const phoneClient = await connectHelper(rpc, port, "com.apple.mobilephone");

    const payloadsPromise = Promise.all([
      readHelperPayload(faceTimeClient),
      readHelperPayload(phoneClient),
    ]);
    const actionPromise = rpc[method]("call-phone");
    const [faceTimePayload, phonePayload] = await payloadsPromise;
    for (const payload of [faceTimePayload, phonePayload]) {
      expect(payload).toMatchObject({ action, data: { callUUID: "call-phone" } });
    }

    sendHelperPayload(faceTimeClient, {
      transactionId: faceTimePayload.transactionId,
      error: "call not found",
    });
    sendHelperPayload(phoneClient, {
      transactionId: phonePayload.transactionId,
      handled: true,
    });

    await expect(actionPromise).resolves.toMatchObject({
      helpersContacted: 2,
      helperResults: [expect.objectContaining({ handled: true })],
      handled: true,
    });
  });

  it("keeps a disconnected carrier peer in inspect-call completeness", async () => {
    const disconnected = Promise.withResolvers<string>();
    const { rpc, port } = await startDefaultHelper({ onDisconnect: disconnected.resolve });

    const faceTimeClient = await connectHelper(rpc, port);
    const phoneClient = await connectHelper(rpc, port, "com.apple.mobilephone", 5678);

    const faceTimeClosed = waitForSocketEvent(faceTimeClient, "close");
    faceTimeClient.destroy();
    await faceTimeClosed;
    expect(await disconnected.promise).toBe("com.apple.FaceTime");
    expect(rpc.connectedSockets).toBe(1);

    const { result } = await exchange(
      phoneClient,
      () => rpc.inspectCall(["call-phone"], [1234]),
      { action: "inspect-call", data: { callUUIDs: ["call-phone"] } },
      { outcome: "absent", found: false },
    );
    await expect(result).resolves.toMatchObject({
      helpersContacted: 1,
      topologyComplete: false,
      helperResults: [
        expect.objectContaining({
          found: false,
          helperPeer: expect.objectContaining({ processId: 5678 }),
        }),
      ],
    });
  });

  it("distinguishes definitive helper rejection from transport failure", async () => {
    const { rpc, client } = await startConnectedHelper();
    const { result } = await exchange(
      client,
      () => rpc.startCall(dialRequest, "dial-2", requestedAt),
      { action: "start-call" },
      { error: "cannot dial" },
    );
    const error = await result.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ message: "cannot dial" });
    expect(error).not.toBeInstanceOf(FaceTimeHelperUnavailableError);
  });

  it("preserves helper-declared ambiguous dial outcomes", async () => {
    const { rpc, client } = await startConnectedHelper();
    const { result } = await exchange(
      client,
      () => rpc.startCall(dialRequest, "dial-3", requestedAt),
      { action: "start-call" },
      {
        error: "dial outcome is unknown",
        ambiguous: true,
        proxy_identifier: "proxy-3",
        helpersContacted: 1,
        topologyGeneration: 99,
        topologyComplete: true,
        helperResults: [{ outcome: "absent", found: false }],
      },
    );

    await expect(result).rejects.toMatchObject({
      name: "FaceTimeHelperAmbiguousError",
      result: {
        proxy_identifier: "proxy-3",
        helpersContacted: undefined,
        topologyGeneration: undefined,
        topologyComplete: undefined,
        helperResults: undefined,
      },
    });
  });

  it("routes outbound calls to FaceTime regardless of helper connection order", async () => {
    const { rpc, port } = await startDefaultHelper();

    const phoneClient = await connectHelper(rpc, port, "com.apple.mobilephone");
    const faceTimeClient = await connectHelper(rpc, port);

    const phoneReceivedAction = vi.fn();
    phoneClient.on("data", phoneReceivedAction);
    const data = { ...dialRequest, mode: "video" as const, dialID: "dial-routed", requestedAt };
    const { result, payload } = await exchange(
      faceTimeClient,
      () => rpc.startCall(data, data.dialID, data.requestedAt),
      { action: "start-call" },
      { call_uuid: "call-routed" },
    );
    expect(payload.data).toEqual(data);
    await expect(result).resolves.toMatchObject({ call_uuid: "call-routed" });
    expect(phoneReceivedAction).not.toHaveBeenCalled();
    faceTimeClient.destroy();
  });

  it("reports a dial as definitely unsent when no helper is connected", async () => {
    const { rpc } = await startDefaultHelper();

    await expect(rpc.startCall(dialRequest, "dial-4", requestedAt)).rejects.toBeInstanceOf(
      FaceTimeHelperUnavailableError,
    );
  });

  it("rejects an authenticated stale helper and reports its process", async () => {
    const onStale = vi.fn();
    const { rpc, port } = await startDefaultHelper({ onStale });

    const client = await connectClient(port);
    await registerHelper(client, rpc, "com.apple.FaceTime", "c".repeat(64), false);
    await waitFor(() => onStale.mock.calls.length > 0);
    expect(onStale).toHaveBeenLastCalledWith("com.apple.FaceTime", 1234);
    expect(rpc.connectedSockets).toBe(0);
  });

  it("rejects the retired pre-build-id authentication shape", async () => {
    const onStale = vi.fn();
    const { rpc, port } = await startDefaultHelper({ onStale });
    const client = await connectClient(port);
    writeFrame(client, { event: "ping", bundle_identifier: "com.apple.FaceTime" });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(onStale).not.toHaveBeenCalled();
    expect(rpc.connectedSockets).toBe(0);
  });

  it("queries the helper for a known outgoing call UUID", async () => {
    const { rpc, client } = await startConnectedHelper();
    const { result } = await exchange(
      client,
      () => rpc.findOutgoingCall("owner@example.com", "call-3", "dial-5", "proxy-3"),
      {
        action: "find-outgoing-call",
        data: {
          handle: "owner@example.com",
          callUUID: "call-3",
          dialID: "dial-5",
          proxyIdentifier: "proxy-3",
        },
      },
      { found: true, call_uuid: "call-3" },
    );
    await expect(result).resolves.toMatchObject({ found: true, call_uuid: "call-3" });
  });

  it("excludes unauthenticated sockets from call-control fanout", async () => {
    const onMessage = vi.fn();
    const { rpc, port } = await startDefaultHelper({ onMessage });

    const faceTimeClient = await connectHelper(rpc, port);
    const rogueClient = await connectClient(port);
    const rogueReceivedAction = vi.fn();
    rogueClient.on("data", rogueReceivedAction);
    const data = {
      dialID: "dial-authenticated",
      handle: "owner@example.com",
      callUUID: "call-authenticated",
      proxyIdentifier: "proxy-authenticated",
    };
    const { result } = await exchange(
      faceTimeClient,
      () => rpc.cancelOutgoingCall(data),
      { action: "cancel-outgoing-call", data },
      { cancelled: true },
    );
    await expect(result).resolves.toMatchObject({
      helpersContacted: 1,
      helperResults: [expect.objectContaining({ cancelled: true })],
      cancelled: true,
    });
    expect(rogueReceivedAction).not.toHaveBeenCalled();

    const rejected = waitForSocketEvent(rogueClient, "close");
    writeFrame(rogueClient, {
      event: "ft-call-status-changed",
      data: { call_uuid: "forged-call", call_status: 1 },
    });
    await rejected;
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("delivers a signed helper event once and closes the connection on replay", async () => {
    const events: unknown[] = [];
    const { rpc, port } = await startDefaultHelper({
      onMessage: (message, peer) => {
        expect(peer).toMatchObject({ bundleIdentifier: "com.apple.FaceTime", processId: 1234 });
        events.push(message);
      },
    });
    const client = await connectHelper(rpc, port);

    const envelope = encodeHelperPayload(client, {
      event: "ft-call-status-changed",
      data: { call_uuid: "call-once" },
    });
    const closed = waitForSocketEvent(client, "close");
    client.write(envelope);
    await waitFor(() => events.length === 1);
    client.write(envelope);
    await closed;

    expect(events).toEqual([{ event: "ft-call-status-changed", data: { call_uuid: "call-once" } }]);
  });

  it.each([
    { name: "complete", payload: `${"x".repeat(64 * 1024 + 1)}\n` },
    { name: "incomplete", payload: "x".repeat(64 * 1024 + 1) },
  ])("closes an oversized $name helper frame before parsing", async ({ payload }) => {
    const { rpc, port } = await startDefaultHelper({
      onMessage: () => {
        throw new Error("oversized input reached the message boundary");
      },
    });
    const client = await connectClient(port);
    const closed = waitForSocketEvent(client, "close");
    client.write(payload);
    await closed;
    expect(rpc.connectedSockets).toBe(0);
  });

  it("closes a byte-dripping unauthenticated helper socket at the absolute deadline", async () => {
    const { rpc, port } = await startDefaultHelper();
    const client = await connectClient(port);
    const closed = waitForSocketEvent(client, "close");
    const socketErrors: Error[] = [];
    // A drip in flight at peer rejection can turn the expected close into a TCP reset.
    client.on("error", (error) => socketErrors.push(error));
    const drip = setInterval(() => client?.write(" "), 250);
    try {
      await closed;
    } finally {
      clearInterval(drip);
    }
    for (const error of socketErrors) {
      expect(error).toMatchObject({ code: "ECONNRESET" });
    }
    expect(rpc.connectedSockets).toBe(0);
  }, 5_000);

  it("rejects helper connections beyond the bounded socket set", async () => {
    const { port } = await startDefaultHelper();
    const sockets: net.Socket[] = [];
    try {
      for (let index = 0; index < 8; index += 1) {
        const socket = net.createConnection({ host: "127.0.0.1", port });
        sockets.push(socket);
        await waitForSocketEvent(socket, "connect");
      }
      const overflow = net.createConnection({ host: "127.0.0.1", port });
      sockets.push(overflow);
      await waitForSocketEvent(overflow, "connect");
      await waitForSocketEvent(overflow, "close");
      expect(overflow.destroyed).toBe(true);
    } finally {
      sockets.forEach((socket) => socket.destroy());
    }
  });
});
