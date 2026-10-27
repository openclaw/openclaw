import net from "node:net";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FaceTimeHelperUnavailableError } from "../src/helper-results.js";
import { FaceTimeHelperSocketServer } from "../src/helper-rpc.js";
import {
  HelperClient,
  TEST_HELPER_AUTH_TOKEN,
  TEST_HELPER_BUILD_ID,
  writeFrame,
  type Payload,
} from "./helper-wire.test-support.js";

const receipt = (result: Payload, helpersContacted = 1) => ({
  ...result,
  helpersContacted,
  helperResults: [result],
});

function waitForSocketEvent(socket: net.Socket, event: "close" | "connect"): Promise<void> {
  return new Promise((resolve) => {
    socket.once(event, () => resolve());
  });
}

const dialRequest = { handle: "owner@example.com", mode: "audio" as const };
const requestedAt = "2026-07-20T17:52:00.000Z";

const waitFor = (predicate: () => boolean) =>
  vi.waitFor(() => expect(predicate()).toBe(true), { interval: 10, timeout: 1000 });

let rpc: FaceTimeHelperSocketServer;
let port: number;
const clients = new Set<net.Socket>();
type ServerOptions = ConstructorParameters<typeof FaceTimeHelperSocketServer>[0];
const onMessage = vi.fn<ServerOptions["onMessage"]>();
const onStale = vi.fn<NonNullable<ServerOptions["onStale"]>>();
const onDisconnect = vi.fn<NonNullable<ServerOptions["onDisconnect"]>>();

beforeEach(async () => {
  onMessage.mockReset();
  onStale.mockReset();
  onDisconnect.mockReset();
  // Observe the real listener so its ephemeral port stays bound until helper.stop().
  const createServer = vi.spyOn(net, "createServer");
  let listener: net.Server;
  try {
    rpc = new FaceTimeHelperSocketServer({
      host: "127.0.0.1",
      port: 0,
      logger: console,
      ipcKey: TEST_HELPER_AUTH_TOKEN,
      buildId: TEST_HELPER_BUILD_ID,
      onMessage,
      onStale,
      onDisconnect,
    });
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
  port = address.port;
});

async function connectClient(): Promise<net.Socket> {
  const socket = net.createConnection({ host: "127.0.0.1", port });
  clients.add(socket);
  socket.setEncoding("utf8");
  await waitForSocketEvent(socket, "connect");
  return socket;
}

async function connectHelper(bundle = "com.apple.FaceTime", processId = 1234) {
  const client = new HelperClient(await connectClient());
  await client.authenticate(
    () => {
      expect(rpc.connectedHelperBundles).not.toContain(bundle);
    },
    bundle,
    processId,
  );
  if (bundle.startsWith("com.apple.FaceTime")) {
    await waitFor(() => rpc.connectedHelperBundles.includes(bundle));
  }
  return client;
}

afterEach(async () => {
  for (const socket of clients) {
    socket.destroy();
  }
  await rpc?.stop();
  clients.clear();
});

it("sends set-muted actions over newline-framed JSON and resolves acknowledgements", async () => {
  const client = await connectHelper();
  const { result, payload } = await client.exchange(
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
    helperResults: [{ conversation_audio_started: true, helperPeer: { processId: 1234 } }],
  });
});

it.each([
  ["answerCall", "answer-call"],
  ["leaveCall", "leave-call"],
] as const)(
  "routes %s only through FaceTime when an old Phone helper connects",
  async (method, action) => {
    const faceTimeClient = await connectHelper();
    const phoneClient = await connectHelper("com.apple.mobilephone");
    const phoneReceivedAction = vi.fn();
    phoneClient.socket.on("data", phoneReceivedAction);
    expect(rpc.connectedSockets).toBe(1);
    const actionPromise = rpc[method]("call-phone");
    const faceTimePayload = await faceTimeClient.read();
    expect(faceTimePayload).toMatchObject({ action, data: { callUUID: "call-phone" } });
    faceTimeClient.send({ transactionId: faceTimePayload.transactionId, handled: true });
    await expect(actionPromise).resolves.toMatchObject(receipt({ handled: true }, 1));
    expect(phoneReceivedAction).not.toHaveBeenCalled();
  },
);

it("does not treat an old Phone peer as a fallback carrier", async () => {
  const disconnected = Promise.withResolvers<string>();
  onDisconnect.mockImplementation(disconnected.resolve);
  const faceTimeClient = await connectHelper();
  const phoneClient = await connectHelper("com.apple.mobilephone", 5678);

  const faceTimeClosed = waitForSocketEvent(faceTimeClient.socket, "close");
  faceTimeClient.socket.destroy();
  await faceTimeClosed;
  expect(await disconnected.promise).toBe("com.apple.FaceTime");
  expect(rpc.connectedSockets).toBe(0);

  const phoneReceivedAction = vi.fn();
  phoneClient.socket.on("data", phoneReceivedAction);
  await expect(rpc.inspectCall(["call-phone"], [1234])).rejects.toBeInstanceOf(
    FaceTimeHelperUnavailableError,
  );
  expect(phoneReceivedAction).not.toHaveBeenCalled();
});

it("ignores call events from an already injected Phone helper", async () => {
  const phoneClient = await connectHelper("com.apple.mobilephone");
  phoneClient.send({
    event: "ft-call-status-changed",
    data: { call_uuid: "phone-call", call_status: 1 },
  });
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  expect(onMessage).not.toHaveBeenCalled();
  expect(rpc.connectedHelperBundles).toEqual([]);
});

it("admits an older Phone helper inertly across native upgrades", async () => {
  const client = new HelperClient(await connectClient());
  await client.authenticate(undefined, "com.apple.mobilephone", 5678, "older-build", false);
  client.send({ event: "ft-call-status-changed", data: { call_uuid: "old-phone-call" } });
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  expect(client.socket.destroyed).toBe(false);
  expect(rpc.connectedSockets).toBe(0);
  expect(onStale).not.toHaveBeenCalled();
  expect(onMessage).not.toHaveBeenCalled();
});

it("distinguishes definitive helper rejection from transport failure", async () => {
  const client = await connectHelper();
  const { result } = await client.exchange(
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
  const client = await connectHelper();
  const { result } = await client.exchange(
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
  const phoneClient = await connectHelper("com.apple.mobilephone");
  const faceTimeClient = await connectHelper();

  const phoneReceivedAction = vi.fn();
  phoneClient.socket.on("data", phoneReceivedAction);
  const data = { ...dialRequest, mode: "video" as const, dialID: "dial-routed", requestedAt };
  const { result, payload } = await faceTimeClient.exchange(
    () => rpc.startCall(data, data.dialID, data.requestedAt),
    { action: "start-call" },
    { call_uuid: "call-routed" },
  );
  expect(payload.data).toEqual(data);
  await expect(result).resolves.toMatchObject({ call_uuid: "call-routed" });
  expect(phoneReceivedAction).not.toHaveBeenCalled();
  faceTimeClient.socket.destroy();
});

it("reports a dial as definitely unsent when no helper is connected", async () => {
  await expect(rpc.startCall(dialRequest, "dial-4", requestedAt)).rejects.toBeInstanceOf(
    FaceTimeHelperUnavailableError,
  );
});

it("rejects an authenticated stale helper and reports its process", async () => {
  const client = await connectClient();
  await new HelperClient(client).authenticate(undefined, undefined, 1234, "c".repeat(64));
  await waitFor(() => onStale.mock.calls.length > 0);
  expect(onStale).toHaveBeenLastCalledWith("com.apple.FaceTime", 1234);
  expect(rpc.connectedSockets).toBe(0);
});

it("rejects the retired pre-build-id authentication shape", async () => {
  const client = await connectClient();
  writeFrame(client, { event: "ping", bundle_identifier: "com.apple.FaceTime" });
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  expect(onStale).not.toHaveBeenCalled();
  expect(rpc.connectedSockets).toBe(0);
});

it("queries the helper for a known outgoing call UUID", async () => {
  const client = await connectHelper();
  const { result } = await client.exchange(
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
  const faceTimeClient = await connectHelper();
  const rogueClient = await connectClient();
  const rogueReceivedAction = vi.fn();
  rogueClient.on("data", rogueReceivedAction);
  const data = {
    dialID: "dial-authenticated",
    handle: "owner@example.com",
    callUUID: "call-authenticated",
    proxyIdentifier: "proxy-authenticated",
  };
  const { result } = await faceTimeClient.exchange(
    () => rpc.cancelOutgoingCall(data),
    { action: "cancel-outgoing-call", data },
    { cancelled: true },
  );
  await expect(result).resolves.toMatchObject(receipt({ cancelled: true }));
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
  const client = await connectHelper();
  const event = {
    event: "ft-call-status-changed",
    data: { call_uuid: "call-once" },
  };
  const envelope = client.encode(event);
  const closed = waitForSocketEvent(client.socket, "close");
  client.socket.write(envelope);
  await waitFor(() => onMessage.mock.calls.length === 1);
  client.socket.write(envelope);
  await closed;

  expect(onMessage.mock.calls).toEqual([
    [event, expect.objectContaining({ bundleIdentifier: "com.apple.FaceTime", processId: 1234 })],
  ]);
});

it.each([
  { name: "complete", payload: `${"x".repeat(64 * 1024 + 1)}\n` },
  { name: "incomplete", payload: "x".repeat(64 * 1024 + 1) },
])("closes an oversized $name helper frame before parsing", async ({ payload }) => {
  onMessage.mockImplementation(() => {
    throw new Error("oversized input reached the message boundary");
  });
  const client = await connectClient();
  const closed = waitForSocketEvent(client, "close");
  client.write(payload);
  await closed;
  expect(rpc.connectedSockets).toBe(0);
});

it("closes a byte-dripping unauthenticated helper socket at the absolute deadline", async () => {
  const client = await connectClient();
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
  for (let index = 0; index < 8; index += 1) {
    await connectClient();
  }
  const overflow = await connectClient();
  await waitForSocketEvent(overflow, "close");
  expect(overflow.destroyed).toBe(true);
});
