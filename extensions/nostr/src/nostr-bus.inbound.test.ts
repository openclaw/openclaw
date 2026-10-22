import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "../runtime-api.js";
import { startNostrBus } from "./nostr-bus.js";
import { setNostrRuntime } from "./runtime.js";
import { buildResolvedNostrAccount, TEST_HEX_PRIVATE_KEY } from "./test-fixtures.js";

const BOT_PUBKEY = "b".repeat(64);
const defaultOnMessage = vi.fn(async () => {});
const onRejected = vi.fn<NonNullable<Parameters<typeof startNostrBus>[0]["onRejected"]>>();

function rateLimit(maxGlobalPerWindow: number, maxPerSenderPerWindow: number) {
  return { windowMs: 60_000, maxGlobalPerWindow, maxPerSenderPerWindow, maxTrackedSenderKeys: 32 };
}

function countRejection(reason: Parameters<typeof onRejected>[0]): number {
  return onRejected.mock.calls.filter(([value]) => value === reason).length;
}

type RelayHandlers = {
  onevent: (event: Record<string, unknown>) => void | Promise<void>;
  oneose?: () => void;
  onclose?: (reason: string[]) => void;
};

const mockState = vi.hoisted(() => ({
  handlers: [] as RelayHandlers[],
  subscribeMany: vi.fn(),
  publish: vi.fn(async (_event: unknown) => "ok"),
  close: vi.fn(),
  subscriptionClose: vi.fn(),
  finalizeEvent: vi.fn((event: unknown) => event),
  readNostrBusState: vi.fn<typeof import("./nostr-state-store.js").readNostrBusState>(
    async () => null,
  ),
  writeNostrBusState: vi.fn(
    async (_state: { lastProcessedAt: number; gatewayStartedAt: number }) => {},
  ),
  computeSinceTimestamp: vi.fn(() => 0),
  verifyEvent: vi.fn(() => true),
  decrypt: vi.fn(() => "plaintext"),
}));

vi.mock("nostr-tools", () => {
  class MockSimplePool {
    maxWaitForConnection = 3_000;

    subscribeMany(relays: string[], filters: unknown, handlers: RelayHandlers) {
      mockState.subscribeMany(relays, filters, handlers);
      mockState.handlers.push(handlers);
      return {
        close: mockState.subscriptionClose,
      };
    }

    async ensureRelay() {
      return { publish: mockState.publish };
    }

    close(relays: string[]) {
      mockState.close(relays);
    }
  }

  return {
    SimplePool: MockSimplePool,
    finalizeEvent: mockState.finalizeEvent,
    getPublicKey: vi.fn(() => BOT_PUBKEY),
    verifyEvent: mockState.verifyEvent,
  };
});

vi.mock("nostr-tools/nip04", () => ({
  decrypt: mockState.decrypt,
  encrypt: vi.fn(() => "ciphertext"),
}));

vi.mock("./nostr-state-store.js", () => ({
  readNostrBusState: mockState.readNostrBusState,
  writeNostrBusState: mockState.writeNostrBusState,
  computeSinceTimestamp: mockState.computeSinceTimestamp,
  readNostrProfileState: vi.fn(async () => null),
  writeNostrProfileState: vi.fn(async () => {}),
}));

function createEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "event-1",
    kind: 4,
    pubkey: "a".repeat(64),
    content: "ciphertext",
    created_at: Math.floor(Date.now() / 1000),
    tags: [["p", BOT_PUBKEY]],
    sig: "test-signature",
    ...overrides,
  };
}

async function emitEvent(overrides: Record<string, unknown>) {
  dispatchEvent(createEvent(overrides));
  while (ingressTasks.length > 0) {
    await Promise.all(ingressTasks.splice(0));
  }
}

function dispatchEvent(event: Record<string, unknown>) {
  const handlers = mockState.handlers[0];
  if (!handlers) {
    throw new Error("missing subscription handlers");
  }
  void handlers.onevent(event);
}

let stateDir = "";
let ingressQueue: ReturnType<typeof createChannelIngressQueueForTests<Record<string, unknown>>>;
let ingressTasks: Promise<void>[] = [];
let activeBus: Awaited<ReturnType<typeof startNostrBus>> | undefined;

function useQueue(openChannelIngressQueue = () => ingressQueue) {
  setNostrRuntime({ state: { openChannelIngressQueue } } as unknown as PluginRuntime);
}

function expectDispatchCounts(verify: number, decrypt: number, delivered: number) {
  expect([
    mockState.verifyEvent.mock.calls.length,
    mockState.decrypt.mock.calls.length,
    defaultOnMessage.mock.calls.length,
  ]).toEqual([verify, decrypt, delivered]);
}

async function startTestNostrBus(options: Partial<Parameters<typeof startNostrBus>[0]> = {}) {
  activeBus = await startNostrBus({
    privateKey: TEST_HEX_PRIVATE_KEY,
    onMessage: defaultOnMessage,
    onRejected,
    ...options,
    trackIngressTask: (task) => ingressTasks.push(task),
  });
  return activeBus;
}

describe("startNostrBus inbound guards", () => {
  beforeEach(async () => {
    const created = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-nostr-ingress-"));
    stateDir = await fs.realpath(created);
    ingressQueue = createChannelIngressQueueForTests<Record<string, unknown>>({
      channelId: "nostr",
      accountId: "default",
      stateDir,
    });
    useQueue();
    mockState.handlers = [];
    ingressTasks = [];
    vi.resetAllMocks();
  });

  afterEach(async () => {
    await activeBus?.close();
    activeBus = undefined;
    mockState.handlers = [];
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("classifies a durable queue open failure as unavailable ingress", async () => {
    const queueError = new Error("sqlite unavailable");
    useQueue(() => {
      throw queueError;
    });
    await expect(startTestNostrBus(buildResolvedNostrAccount())).rejects.toMatchObject({
      name: "ChannelIngressUnavailableError",
      code: "CHANNEL_INGRESS_UNAVAILABLE",
      cause: queueError,
    });
    expect(mockState.subscribeMany).not.toHaveBeenCalled();
  });

  it("delivers recovered old claims while fencing old live relay events", async () => {
    const recoveredId = "recovered-old";
    const recoveredPubkey = "a".repeat(64);
    const recovered = createEvent({ id: recoveredId, pubkey: recoveredPubkey, created_at: 1_000 });
    await ingressQueue.enqueue(
      recoveredId,
      { version: 1, receivedAt: Date.now(), rawEvent: JSON.stringify(recovered) },
      { laneKey: `direct:${recoveredPubkey}` },
    );
    const enqueue = vi.spyOn(ingressQueue, "enqueue");
    mockState.computeSinceTimestamp.mockReturnValue(2_000);
    await startTestNostrBus(buildResolvedNostrAccount());
    await vi.waitFor(() => expect(defaultOnMessage).toHaveBeenCalledTimes(1));
    await emitEvent({ id: "live-old", created_at: 1_001 });
    expect(defaultOnMessage).toHaveBeenCalledTimes(1);
    expect(enqueue).not.toHaveBeenCalled();
    expect(countRejection("stale")).toBe(1);
  });

  it("closes the relay pool after the active subscription closes", async () => {
    const subscriptionClosed = createDeferred<void>();
    mockState.subscriptionClose.mockImplementationOnce(async () => {
      await subscriptionClosed.promise;
    });
    const bus = await startTestNostrBus({ relays: ["wss://relay.example"] });
    const closing = bus.close();
    expect(mockState.subscriptionClose).toHaveBeenCalledWith("closed by caller");
    expect(mockState.close).not.toHaveBeenCalled();

    subscriptionClosed.resolve();
    await closing;
    expect(mockState.close).toHaveBeenCalledWith(["wss://relay.example"]);
  });

  it("terminates the relay subscription when durable admission fails", async () => {
    const appendError = new Error("sqlite unavailable");
    useQueue(() => ({ ...ingressQueue, enqueue: vi.fn().mockRejectedValue(appendError) }));
    const onError = vi.fn();
    await startTestNostrBus({
      ...buildResolvedNostrAccount(),
      relays: ["wss://relay.example"],
      onError,
    });
    await emitEvent({ id: "admission-failure" });
    expect(mockState.subscriptionClose).toHaveBeenCalledWith("durable admission failed");
    expect(mockState.close).toHaveBeenCalledWith(["wss://relay.example"]);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("durable admission failed") }),
      "durable admission for event admission-failure",
    );
    expect(defaultOnMessage).not.toHaveBeenCalled();
  });

  it("keeps relays open after rejecting one oversized raw event", async () => {
    await startTestNostrBus(buildResolvedNostrAccount());
    await emitEvent({ id: "raw-oversized", content: "x".repeat(40_000) });
    expect(mockState.subscriptionClose).not.toHaveBeenCalled();
    expect(defaultOnMessage).not.toHaveBeenCalled();
    await emitEvent({ id: "after-raw-oversized", content: "ok" });
    expect(mockState.subscriptionClose).not.toHaveBeenCalled();
    expect(defaultOnMessage).toHaveBeenCalledTimes(1);
  });

  it("awaits ingress drain shutdown when startup state persistence fails", async () => {
    const startupError = new Error("state unavailable");
    const claimNext = vi.spyOn(ingressQueue, "claimNext");
    const pruneStarted = createDeferred<void>();
    const pruneGate = createDeferred<void>();
    let pruneActive = false;
    const prune = vi.fn(async (...args: Parameters<typeof ingressQueue.prune>) => {
      pruneActive = true;
      pruneStarted.resolve();
      try {
        await pruneGate.promise;
        return await ingressQueue.prune(...args);
      } finally {
        pruneActive = false;
      }
    });
    useQueue(() => ({ ...ingressQueue, prune }));
    mockState.writeNostrBusState.mockRejectedValueOnce(startupError);
    const startup = startTestNostrBus(buildResolvedNostrAccount());
    const settled = vi.fn();
    void startup.then(settled, settled);
    await pruneStarted.promise;
    await Promise.resolve();
    try {
      expect(pruneActive).toBe(true);
      expect(settled).not.toHaveBeenCalled();
    } finally {
      pruneGate.resolve();
    }
    await expect(startup).rejects.toThrow("state unavailable");
    expect(pruneActive).toBe(false);
    expect(prune).toHaveBeenCalledOnce();
    expect(claimNext).not.toHaveBeenCalled();
  });

  it("links authorization replies to the inbound NIP-04 event", async () => {
    const inboundEventId = "c".repeat(64);
    const senderPubkey = "a".repeat(64);
    const authorizeSender = vi.fn(async ({ reply }: { reply: (text: string) => Promise<void> }) => {
      await reply("pairing reply");
      return "pairing" as const;
    });
    await startTestNostrBus({
      relays: ["wss://relay.example"],
      authorizeSender,
    });
    await emitEvent({ id: inboundEventId, pubkey: senderPubkey });
    expect(mockState.finalizeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: [
          ["p", senderPubkey],
          ["e", inboundEventId],
        ],
      }),
      expect.any(Uint8Array),
    );
  });

  it.each([
    ["invalid-signature", false, "a".repeat(64), "allow", 1, 0],
    ["self-message", true, BOT_PUBKEY, "allow", 0, 0],
    ["blocked", true, `blocked${"a".repeat(57)}`, "block", 1, 1],
  ] as const)(
    "dedupes replayed %s events before guards rerun",
    async (reason, valid, pubkey, decision, verified, authorized) => {
      mockState.verifyEvent.mockReturnValue(valid);
      const authorizeSender = vi.fn(async () => decision);
      await startTestNostrBus({ authorizeSender });
      const event = createEvent({ id: `${reason}-replay`, pubkey });
      await emitEvent(event);
      await emitEvent(event);
      expectDispatchCounts(verified, 0, 0);
      expect(authorizeSender).toHaveBeenCalledTimes(authorized);
      if (!valid) {
        expect(countRejection("invalid_signature")).toBe(1);
      }
    },
  );

  it("rate limits repeated invalid signatures before authorization work fans out", async () => {
    mockState.verifyEvent.mockReturnValue(false);
    const authorizeSender = vi.fn(async () => "allow" as const);
    await startTestNostrBus({
      authorizeSender,
      guardPolicy: { rateLimit: rateLimit(1, 10) },
    });
    await emitEvent({ id: "invalid-1" });
    await emitEvent({ id: "invalid-2" });
    expect(mockState.verifyEvent).toHaveBeenCalledTimes(1);
    expect(authorizeSender).not.toHaveBeenCalled();
    expect(countRejection("invalid_signature")).toBe(1);
    expect(countRejection("rate_limited")).toBe(1);
  });

  it("rate limits repeated events before decrypt", async () => {
    await startTestNostrBus();
    for (let i = 0; i < 21; i += 1) {
      await emitEvent({ id: `event-${i}` });
    }
    expect(countRejection("rate_limited")).toBe(1);
    expect(mockState.decrypt).toHaveBeenCalledTimes(20);
    expect(defaultOnMessage).toHaveBeenCalledTimes(20);
  });

  it("retries a replayed event after the message handler fails", async () => {
    const onMessage = vi
      .fn<(sender: string, plaintext: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);
    await startTestNostrBus({ onMessage });
    const event = createEvent({ id: "retry-after-handler-failure" });
    await emitEvent(event);
    await emitEvent(event);
    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledTimes(2), { timeout: 3_000 });
    expect(mockState.verifyEvent).toHaveBeenCalledTimes(2);
    expect(mockState.decrypt).toHaveBeenCalledTimes(2);
    expect(onMessage).toHaveBeenCalledTimes(2);
  });

  it("does not rate limit an allowed sender while another authorization is still pending", async ({
    signal,
  }) => {
    const delivered = createDeferred<void>();
    const onMessage = vi.fn(async () => delivered.resolve());
    const authorizing = createDeferred<void>();
    const blocked = createDeferred<"block">();
    const authorizeSender = vi
      .fn<(params: { senderPubkey: string }) => Promise<"allow" | "block" | "pairing">>()
      .mockImplementationOnce(async () => {
        authorizing.resolve();
        return await blocked.promise;
      })
      .mockResolvedValueOnce("allow");
    const bus = await startTestNostrBus({
      onMessage,
      authorizeSender,
      guardPolicy: { rateLimit: rateLimit(2, 1) },
    });
    try {
      dispatchEvent(createEvent({ id: "blocked-pending", pubkey: `blocked${"a".repeat(57)}` }));
      await withinTest(authorizing.promise, signal);
      dispatchEvent(
        createEvent({ id: "allowed-during-pending-auth", pubkey: `allowed${"b".repeat(57)}` }),
      );
      await withinTest(delivered.promise, signal);
      blocked.resolve("block");
      await Promise.all(ingressTasks.splice(0));

      expect(authorizeSender).toHaveBeenCalledTimes(2);
      expect(mockState.decrypt).toHaveBeenCalledTimes(1);
      expect(onMessage).toHaveBeenCalledTimes(1);
      expect(countRejection("rate_limited")).toBe(0);
    } finally {
      blocked.resolve("block");
      await bus.close();
    }
  });

  it("charges oversized ciphertext globally while retaining rejected events in replay overlap", async () => {
    mockState.readNostrBusState.mockResolvedValueOnce({
      version: 2,
      lastProcessedAt: 1_000,
      gatewayStartedAt: 900,
      recentEventIds: [],
    });
    mockState.computeSinceTimestamp.mockReturnValue(1_000);
    const bus = await startTestNostrBus({
      ...buildResolvedNostrAccount(),
      relays: ["wss://relay.example"],
      guardPolicy: { maxCiphertextBytes: 4, rateLimit: rateLimit(1, 10) },
    });
    expect(mockState.writeNostrBusState).toHaveBeenCalledWith(
      expect.objectContaining({ lastProcessedAt: 1_000, gatewayStartedAt: 900 }),
    );
    await emitEvent({
      id: "oversized-durable",
      pubkey: `sender1${"a".repeat(57)}`,
      content: "ciphertext-too-large",
      created_at: 2_000,
    });
    mockState.handlers[0]?.oneose?.();
    await emitEvent({
      id: "oversized-rejected",
      pubkey: `sender2${"b".repeat(57)}`,
      content: "ciphertext-too-large",
      created_at: 900,
    });
    expect(countRejection("oversized_ciphertext")).toBe(1);
    expect(countRejection("rate_limited")).toBe(1);
    expectDispatchCounts(0, 0, 0);
    await bus.close();
    expect(mockState.writeNostrBusState.mock.calls.at(-1)?.[0]?.lastProcessedAt).toBe(1_020);
  });

  it("does not spend per-sender buckets on oversized ciphertext before verification", async () => {
    await startTestNostrBus({
      guardPolicy: { maxCiphertextBytes: 4, rateLimit: rateLimit(10, 1) },
    });
    await emitEvent({ id: "oversized-sender-1", content: "ciphertext-too-large" });
    await emitEvent({ id: "oversized-sender-2", content: "ciphertext-too-large" });
    await emitEvent({ id: "allowed-after-oversized", content: "ok" });
    expect(countRejection("oversized_ciphertext")).toBe(2);
    expect(countRejection("rate_limited")).toBe(0);
    expectDispatchCounts(1, 1, 1);
  });

  it("rejects far-future events before crypto", async () => {
    const bus = await startTestNostrBus();
    await emitEvent({ created_at: Math.floor(Date.now() / 1000) + 600 });
    expect(countRejection("future")).toBe(1);
    expectDispatchCounts(0, 0, 0);
    await bus.close();
    const persisted = mockState.writeNostrBusState.mock.calls.at(-1)?.[0];
    expect(persisted?.lastProcessedAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
  });
});
