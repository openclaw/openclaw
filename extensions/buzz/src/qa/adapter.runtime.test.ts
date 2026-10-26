import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  QaBusInboundMessageInput,
  QaBusMessage,
  QaBusOutboundMessageInput,
} from "openclaw/plugin-sdk/qa-channel-protocol";
import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import type { BuzzInboundMessage } from "../message-event.js";
import { parseBuzzQaCredentialPayload } from "./credentials.js";

const sent = { eventId: "native-inbound", timestamp: 1_750_000_000_000 };
const credentialPayload = {
  relayUrl: "wss://relay.qa.example",
  roomId: "123e4567-e89b-42d3-a456-426614174000",
  driverPrivateKey: "01".repeat(32),
  sutPrivateKey: "02".repeat(32),
};
const credentials = parseBuzzQaCredentialPayload(credentialPayload);
const tempDirs: string[] = [];

afterEach(() =>
  Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true }))),
);

type RelayHandler = (message: Omit<BuzzInboundMessage, "kind" | "diff">) => Promise<void>;
const release = vi.hoisted(() => vi.fn(async () => {}));
const heartbeatStop = vi.hoisted(() => vi.fn(async () => {}));
const readBuzzQaCredentialFile = vi.hoisted(() => vi.fn());
const sendMessage = vi.hoisted(() => vi.fn(async () => sent));
const closeRelay = vi.hoisted(() => vi.fn(async () => {}));
const relayDriverState = vi.hoisted(() => ({
  onMessage: undefined as RelayHandler | undefined,
}));
type AdapterContext = Parameters<typeof createBuzzQaTransportAdapter>[0];
type AcquireOptions = Parameters<AdapterContext["credentials"]["acquire"]>[0];
const acquireLease = vi.fn(async (_options: AcquireOptions) => ({ payload: credentials, release }));
vi.mock("./relay-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./relay-client.js")>()),
  createBuzzQaRelayDriver: async (params: { onMessage: RelayHandler }) => {
    relayDriverState.onMessage = params.onMessage;
    return { assertHealthy: vi.fn(), close: closeRelay, sendMessage };
  },
}));

vi.mock("./credentials.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./credentials.js")>()),
  readBuzzQaCredentialFile,
}));

import { createBuzzQaTransportAdapter } from "./adapter.runtime.js";

const credentialHost: AdapterContext["credentials"] = {
  acquire: async (options) => (await acquireLease(options)) as never,
  startHeartbeat: () => ({ getFailure: () => null, stop: heartbeatStop, throwIfFailed: vi.fn() }),
};

const inbound = {
  accountId: "sut",
  conversation: { id: "main", kind: "channel" as const },
  senderId: "driver",
  text: "@openclaw root",
};
const busMessage: QaBusMessage = {
  ...inbound,
  id: "bus-inbound",
  direction: "inbound",
  timestamp: sent.timestamp,
  reactions: [],
};

function createMessages() {
  let inboundIndex = 0;
  let outboundIndex = 0;
  return {
    addInboundMessage: vi.fn(async (input: QaBusInboundMessageInput): Promise<QaBusMessage> => ({
      ...busMessage,
      ...input,
      id: ++inboundIndex === 1 ? "bus-inbound" : `bus-inbound-${inboundIndex}`,
    })),
    addOutboundMessage: vi.fn(async (_input: QaBusOutboundMessageInput) => ({
      ...busMessage,
      id: `bus-outbound-${++outboundIndex}`,
      direction: "outbound" as const,
    })),
    editMessage: vi.fn(),
  };
}
let messages: ReturnType<typeof createMessages>;

async function emitRelay(threadId: string, replyToId = threadId) {
  await relayDriverState.onMessage?.({
    id: `reply-${replyToId}`,
    senderPubkey: credentials.sutPublicKey,
    text: "fast reply",
    channelId: credentials.roomId,
    createdAt: 1_750_000_000,
    mentionedPubkeys: [],
    threadId,
    replyToId,
  });
}

function createAdapter(
  adapterOptions: AdapterContext["adapterOptions"] = { credentialSource: "convex" },
) {
  return createBuzzQaTransportAdapter({
    adapterOptions,
    channelId: "buzz",
    credentials: credentialHost,
    driver: "live",
    messages,
    outputDir: ".artifacts/qa-e2e/buzz",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  messages = createMessages();
  relayDriverState.onMessage = undefined;
  sendMessage.mockResolvedValue(sent);
  readBuzzQaCredentialFile.mockResolvedValue(credentials);
});

it("leaves credential source selection to the host when no file is configured", async () => {
  await createAdapter({});
  expect(readBuzzQaCredentialFile).not.toHaveBeenCalled();
  expect(acquireLease.mock.lastCall?.[0]).toMatchObject({
    kind: "buzz",
    source: undefined,
  });
});

it("selects the literal file when its name has surrounding whitespace", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-buzz-qa-"));
  tempDirs.push(repoRoot);
  const write = (name: string, roomId = credentials.roomId) =>
    fs.writeFile(path.join(repoRoot, name), JSON.stringify({ ...credentialPayload, roomId }), {
      mode: 0o600,
    });
  await write("buzz.json", "123e4567-e89b-42d3-a456-426614174001");
  await write(" buzz.json ");

  const { readBuzzQaCredentialFile: realReader } =
    await vi.importActual<typeof import("./credentials.js")>("./credentials.js");
  readBuzzQaCredentialFile.mockImplementation(realReader);
  await createAdapter({ credentialFile: " buzz.json ", repoRoot });
  expect(acquireLease.mock.lastCall?.[0]).toMatchObject({ source: "env" });
  expect(acquireLease.mock.lastCall?.[0].resolveEnvPayload?.()).toMatchObject({
    roomId: credentials.roomId,
  });
});

it("waits for the default Buzz gateway account rather than the portable account", async () => {
  const gateway = {
    call: async () => ({ channelAccounts: { buzz: [{ accountId: "default", running: true }] } }),
  };
  await expect((await createAdapter()).waitReady({ gateway })).resolves.toBeUndefined();
});

it("maps native Buzz reply relations back to portable thread ids", async () => {
  sendMessage
    .mockResolvedValueOnce({ eventId: "native-root", timestamp: 1_750_000_000_000 })
    .mockResolvedValueOnce({ eventId: "native-follow-up", timestamp: 1_750_000_001_000 });
  const adapter = await createAdapter();

  const root = await adapter.sendInbound(inbound);
  expect(messages.addInboundMessage.mock.lastCall?.[0]).toMatchObject({
    accountId: "sut",
    senderId: credentials.driverPublicKey,
    timestamp: sent.timestamp,
  });
  await emitRelay("native-root");
  const followUp = await adapter.sendInbound({
    ...inbound,
    text: "@openclaw follow-up",
    threadId: root.id,
  });
  await emitRelay("native-root", "native-follow-up");

  expect(sendMessage).toHaveBeenLastCalledWith({
    mentionSut: true,
    text: "@openclaw follow-up",
    threadId: "native-root",
  });
  expect(messages.addOutboundMessage.mock.lastCall?.[0]).toMatchObject({
    to: "channel:main",
    threadId: root.id,
    replyToId: followUp.id,
  });
});

it("waits for a racing inbound id mapping before recording reply relations", async () => {
  const { promise: inboundGate, resolve: releaseInbound } = Promise.withResolvers<void>();
  const { addInboundMessage, addOutboundMessage } = messages;
  const recordInbound = addInboundMessage.getMockImplementation()!;
  addInboundMessage.mockImplementationOnce(async (input) => {
    await inboundGate;
    return recordInbound(input);
  });
  const adapter = await createAdapter();

  const inboundPromise = adapter.sendInbound({
    ...inbound,
    conversation: { id: "main", kind: "group" },
  });
  await vi.waitFor(() => expect(addInboundMessage).toHaveBeenCalledOnce());
  const outboundPromise = emitRelay("native-inbound");
  expect(addOutboundMessage).not.toHaveBeenCalled();

  releaseInbound();
  await Promise.all([inboundPromise, outboundPromise]);

  expect(addOutboundMessage.mock.lastCall?.[0]).toMatchObject({
    threadId: "bus-inbound",
    replyToId: "bus-inbound",
  });
});

it("closes relay observation before stopping and releasing the credential lease", async () => {
  const adapter = await createAdapter({ credentialSource: "convex" });

  await adapter.cleanup?.();
  await adapter.cleanupAfterGatewayStop?.();

  const calls = [closeRelay, heartbeatStop, release].map((mock) => mock.mock.invocationCallOrder);
  expect(calls.map((order) => order.length)).toEqual([1, 1, 1]);
  const [closed, stopped, released] = calls.map(([first]) => first);
  assert(closed !== undefined && stopped !== undefined && released !== undefined);
  expect(closed).toBeLessThan(stopped);
  expect(stopped).toBeLessThan(released);
});
