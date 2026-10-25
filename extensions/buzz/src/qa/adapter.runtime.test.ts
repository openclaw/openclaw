import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  parseQaTarget,
  type QaBusInboundMessageInput,
  type QaBusMessage,
  type QaBusOutboundMessageInput,
} from "openclaw/plugin-sdk/qa-channel-protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
const acquireQaCredentialLease = vi.fn(
  async (_options: Parameters<AdapterContext["credentials"]["acquire"]>[0]) => ({
    source: "env" as const,
    kind: "buzz",
    payload: credentials,
    heartbeatIntervalMs: 0,
    leaseTtlMs: 0,
    heartbeat: vi.fn(async () => {}),
    release,
  }),
);
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
  acquire: async (options) => (await acquireQaCredentialLease(options)) as never,
  startHeartbeat: () => ({ getFailure: () => null, stop: heartbeatStop, throwIfFailed: vi.fn() }),
};

function createMessages() {
  let inboundIndex = 0;
  let outboundIndex = 0;
  return {
    addInboundMessage: vi.fn(async (input: QaBusInboundMessageInput): Promise<QaBusMessage> => ({
      ...input,
      id: ++inboundIndex === 1 ? "bus-inbound" : `bus-inbound-${inboundIndex}`,
      accountId: input.accountId ?? "sut",
      direction: "inbound",
      timestamp: input.timestamp ?? 1_750_000_000_000,
      reactions: [],
    })),
    addOutboundMessage: vi.fn(async (input: QaBusOutboundMessageInput) => {
      const target = parseQaTarget(input.to);
      return {
        ...input,
        id: `bus-outbound-${++outboundIndex}`,
        accountId: input.accountId ?? "sut",
        senderId: input.senderId ?? credentials.sutPublicKey,
        timestamp: input.timestamp ?? sent.timestamp,
        reactions: [],
        direction: "outbound" as const,
        conversation: { id: target.conversationId, kind: target.chatType },
      };
    }),
    editMessage: vi.fn(),
  };
}
let messages: ReturnType<typeof createMessages>;

const inbound = {
  accountId: "sut",
  conversation: { id: "main", kind: "channel" as const },
  senderId: "driver",
  text: "@openclaw root",
};

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
  adapterOptions: AdapterContext["adapterOptions"] = {
    credentialSource: "convex",
    sutAccountId: "sut",
  },
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
  expect(acquireQaCredentialLease.mock.lastCall?.[0]).toMatchObject({
    kind: "buzz",
    source: undefined,
  });
});

it("selects the literal file when its name has surrounding whitespace", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-buzz-qa-"));
  tempDirs.push(repoRoot);
  const neighborPayload = {
    ...credentialPayload,
    roomId: "123e4567-e89b-42d3-a456-426614174001",
  };
  await fs.writeFile(path.join(repoRoot, "buzz.json"), JSON.stringify(neighborPayload), {
    mode: 0o600,
  });
  await fs.writeFile(path.join(repoRoot, " buzz.json "), JSON.stringify(credentialPayload), {
    mode: 0o600,
  });

  const { readBuzzQaCredentialFile: realReader } =
    await vi.importActual<typeof import("./credentials.js")>("./credentials.js");
  readBuzzQaCredentialFile.mockImplementation(realReader);
  await createAdapter({ credentialFile: " buzz.json ", repoRoot });
  expect(readBuzzQaCredentialFile).toHaveBeenCalledWith({ filePath: " buzz.json ", repoRoot });
  expect(acquireQaCredentialLease.mock.lastCall?.[0]).toMatchObject({
    kind: "buzz",
    source: "env",
  });
  const resolvedPayload = acquireQaCredentialLease.mock.lastCall?.[0].resolveEnvPayload?.();
  expect(resolvedPayload).toMatchObject({ roomId: credentials.roomId });
  expect(resolvedPayload).not.toMatchObject({ roomId: neighborPayload.roomId });
});

it("waits for the default Buzz gateway account rather than the portable account", async () => {
  const adapter = await createAdapter();
  const gateway = {
    call: vi.fn(async () => ({
      channelAccounts: { buzz: [{ accountId: "default", running: true }] },
    })),
  };
  await adapter.waitReady({ gateway });
  expect(gateway.call).toHaveBeenCalledWith(
    "channels.status",
    { probe: false, timeoutMs: 2_000 },
    { timeoutMs: 5_000 },
  );
});

it("maps native Buzz reply relations back to portable thread ids", async () => {
  sendMessage
    .mockResolvedValueOnce({ eventId: "native-root", timestamp: 1_750_000_000_000 })
    .mockResolvedValueOnce({ eventId: "native-follow-up", timestamp: 1_750_000_001_000 });
  const adapter = await createAdapter();

  const root = await adapter.sendInbound(inbound);
  expect(sendMessage).toHaveBeenCalledWith({ mentionSut: true, text: inbound.text });
  expect(messages.addInboundMessage.mock.lastCall?.[0]).toMatchObject({
    accountId: "sut",
    senderId: credentials.driverPublicKey,
    timestamp: sent.timestamp,
  });
  expect(root.id).toBe("bus-inbound");
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
  await inboundPromise;
  await outboundPromise;

  expect(addOutboundMessage.mock.lastCall?.[0]).toMatchObject({
    threadId: "bus-inbound",
    replyToId: "bus-inbound",
  });
});

it("closes relay observation before stopping and releasing the credential lease", async () => {
  const adapter = await createAdapter({ credentialSource: "convex" });

  await adapter.cleanup?.();
  await adapter.cleanupAfterGatewayStop?.();

  expect(closeRelay).toHaveBeenCalledOnce();
  expect(heartbeatStop).toHaveBeenCalledOnce();
  expect(release).toHaveBeenCalledOnce();
  const closed = closeRelay.mock.invocationCallOrder[0];
  const stopped = heartbeatStop.mock.invocationCallOrder[0] ?? 0;
  expect(closed).toBeLessThan(stopped);
  expect(stopped).toBeLessThan(release.mock.invocationCallOrder[0] ?? 0);
});
