import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import * as guardPolicy from "openclaw/plugin-sdk/direct-dm-guard-policy";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "../runtime-api.js";
import { startNostrBus } from "./nostr-bus.js";
import { setNostrRuntime } from "./runtime.js";
import { TEST_HEX_PRIVATE_KEY } from "./test-fixtures.js";

const BOT_PUBKEY = "b".repeat(64);
const onDelivered = vi.fn(async () => {});
const createGuardPolicy = guardPolicy.createDirectDmPreCryptoGuardPolicy;
const onRejected = vi.fn<NonNullable<Parameters<typeof startNostrBus>[0]["onRejected"]>>();
const BACKFILL_RELAYS = ["wss://one.example", "wss://two.example"];
const ACCOUNT = { accountId: "default", relays: ["wss://relay.example.com"] };

function rateLimit(maxGlobalPerWindow: number, maxPerSenderPerWindow: number) {
  return { windowMs: 60_000, maxGlobalPerWindow, maxPerSenderPerWindow, maxTrackedSenderKeys: 32 };
}

const countRejection = (reason: Parameters<typeof onRejected>[0]) =>
  onRejected.mock.calls.filter(([value]) => value === reason).length;

type RelayHandlers = {
  onevent: (event: Record<string, unknown>) => void | Promise<void>;
  oneose?: () => void;
  onclose?: (reasons: Array<{ url: string; reason: string }>) => void;
};

const mocks = vi.hoisted(() => ({
  handlers: [] as RelayHandlers[],
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
vi.mock("nostr-tools", () => ({
  SimplePool: class {
    maxWaitForConnection = 3_000;

    subscribeMany(relays: string[], _filters: unknown, handlers: RelayHandlers) {
      mocks.handlers.push(handlers);
      return {
        close: async (reason: string) => {
          await mocks.subscriptionClose(reason);
          handlers.onclose?.(relays.map((url) => ({ url, reason })));
        },
      };
    }

    ensureRelay = async () => ({ publish: async (_event: unknown) => "ok" });
    close = mocks.close;
  },
  finalizeEvent: mocks.finalizeEvent,
  getPublicKey: vi.fn(() => BOT_PUBKEY),
  verifyEvent: mocks.verifyEvent,
}));
vi.mock("nostr-tools/nip04", () => ({
  decrypt: mocks.decrypt,
  encrypt: vi.fn(() => "ciphertext"),
}));
// mock-isolation: Ingress fixtures control cursor reads and write failures without persisted bus state.
vi.mock("./nostr-state-store.js", () => ({
  readNostrBusState: mocks.readNostrBusState,
  writeNostrBusState: mocks.writeNostrBusState,
  computeSinceTimestamp: mocks.computeSinceTimestamp,
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

const dispatchEvent = (event: Record<string, unknown>) => void mocks.handlers[0]!.onevent(event);

let stateDir = "";
let ingressQueue: ReturnType<typeof createChannelIngressQueueForTests<Record<string, unknown>>>;
let ingressTasks: Promise<void>[] = [];
let activeBus: Awaited<ReturnType<typeof startNostrBus>> | undefined;

function useQueue(openChannelIngressQueue = () => ingressQueue) {
  setNostrRuntime({ state: { openChannelIngressQueue } } as unknown as PluginRuntime);
}

function expectDispatchCounts(verify: number, decrypt: number, delivered: number) {
  const calls = [mocks.verifyEvent, mocks.decrypt, onDelivered].map((fn) => fn.mock.calls.length);
  expect(calls).toEqual([verify, decrypt, delivered]);
}

async function startBus(
  options: Partial<Parameters<typeof startNostrBus>[0]> = {},
  overrides?: Parameters<typeof createGuardPolicy>[0],
) {
  const policy = overrides && vi.spyOn(guardPolicy, "createDirectDmPreCryptoGuardPolicy");
  policy?.mockReturnValue(createGuardPolicy(overrides));
  try {
    activeBus = await startNostrBus({
      privateKey: TEST_HEX_PRIVATE_KEY,
      onMessage: onDelivered,
      onRejected,
      ...options,
      trackIngressTask: (task) => ingressTasks.push(task),
    });
    return activeBus;
  } finally {
    policy?.mockRestore();
  }
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
    mocks.handlers = [];
    ingressTasks = [];
    vi.resetAllMocks();
  });

  afterEach(async () => {
    try {
      await activeBus?.close();
    } finally {
      activeBus = undefined;
      mocks.handlers = [];
      vi.useRealTimers();
      closeOpenClawStateDatabaseForTest();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it.for(["confirmed", "timeout", "remote close"])(
    "settles relay backfill after %s",
    async (cause, { signal }) => {
      if (cause === "timeout") {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      }
      const complete = createDeferred<void>();
      const onEose = vi.fn(() => complete.resolve()),
        onDisconnect = vi.fn(),
        onError = vi.fn();
      const bus = await startBus({
        relays: BACKFILL_RELAYS,
        onEose,
        onDisconnect,
        onError,
      });
      expect(mocks.handlers).toHaveLength(2);
      if (cause === "timeout") {
        await vi.advanceTimersByTimeAsync(10_000);
      }
      mocks.handlers[0]?.oneose?.();
      if (cause === "remote close") {
        mocks.handlers[0]?.onclose?.([{ url: BACKFILL_RELAYS[0]!, reason: "relay unavailable" }]);
        expect(onDisconnect).toHaveBeenCalledExactlyOnceWith(BACKFILL_RELAYS[0]);
        expect(onError).toHaveBeenCalledOnce();
      }
      mocks.handlers[1]?.oneose?.();
      if (cause === "confirmed") {
        await withinTest(complete.promise, signal);
        expect(onEose).toHaveBeenCalledExactlyOnceWith(BACKFILL_RELAYS.join(", "));
      }
      await Promise.resolve();
      await bus.close();
      if (cause !== "confirmed") {
        expect(onEose).not.toHaveBeenCalled();
      }
    },
  );

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
    mocks.computeSinceTimestamp.mockReturnValue(2_000);
    await startBus(ACCOUNT);
    await vi.waitFor(() => expect(onDelivered).toHaveBeenCalledTimes(1));
    await emitEvent({ id: "live-old", created_at: 1_001 });
    expect(onDelivered).toHaveBeenCalledTimes(1);
    expect(enqueue).not.toHaveBeenCalled();
    expect(countRejection("stale")).toBe(1);
  });

  it("closes the relay pool after the active subscription closes", async () => {
    const onDisconnect = vi.fn(),
      onError = vi.fn();
    const relays = ["wss://one.example", "wss://two.example"];
    const subscriptionClosed = createDeferred<void>();
    mocks.subscriptionClose.mockImplementationOnce(() => subscriptionClosed.promise);
    const bus = await startBus({ relays, onDisconnect, onError });
    const closing = bus.close();
    expect(mocks.subscriptionClose).toHaveBeenCalledWith("closed by caller");
    expect(mocks.close).not.toHaveBeenCalled();

    subscriptionClosed.resolve();
    await closing;
    expect(mocks.close).toHaveBeenCalledWith(relays);
    expect(onDisconnect).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("terminates the relay subscription when durable admission fails", async () => {
    const appendError = new Error("sqlite unavailable");
    useQueue(() => ({ ...ingressQueue, enqueue: vi.fn().mockRejectedValue(appendError) }));
    const onError = vi.fn();
    await startBus({
      ...ACCOUNT,
      relays: ["wss://relay.example"],
      onError,
    });
    await emitEvent({ id: "admission-failure" });
    expect(mocks.subscriptionClose).toHaveBeenCalledWith("durable admission failed");
    expect(mocks.close).toHaveBeenCalledWith(["wss://relay.example"]);
    expect(onError).toHaveBeenCalled();
    expect(onDelivered).not.toHaveBeenCalled();
  });

  it("awaits ingress drain shutdown when startup state persistence fails", async () => {
    const startupError = new Error("state unavailable");
    const claimNext = vi.spyOn(ingressQueue, "claimNext");
    const pruneStarted = createDeferred<void>();
    const pruneGate = createDeferred<void>();
    const prune = vi.fn(async (...args: Parameters<typeof ingressQueue.prune>) => {
      pruneStarted.resolve();
      await pruneGate.promise;
      return ingressQueue.prune(...args);
    });
    useQueue(() => ({ ...ingressQueue, prune }));
    mocks.writeNostrBusState.mockRejectedValueOnce(startupError);
    const startup = startBus(ACCOUNT);
    const settled = vi.fn();
    void startup.then(settled, settled);
    await pruneStarted.promise;
    await Promise.resolve();
    try {
      expect(settled).not.toHaveBeenCalled();
    } finally {
      pruneGate.resolve();
    }
    await expect(startup).rejects.toThrow("state unavailable");
    expect(claimNext).not.toHaveBeenCalled();
  });

  it("links authorization replies to the inbound NIP-04 event", async () => {
    const inboundEventId = "c".repeat(64);
    const senderPubkey = "a".repeat(64);
    const authorizeSender = vi.fn(async ({ reply }: { reply: (text: string) => Promise<void> }) => {
      await reply("pairing reply");
      return "pairing" as const;
    });
    await startBus({
      relays: ["wss://relay.example"],
      authorizeSender,
    });
    await emitEvent({ id: inboundEventId, pubkey: senderPubkey });
    expect(mocks.finalizeEvent.mock.calls[0]?.[0]).toMatchObject({
      tags: [
        ["p", senderPubkey],
        ["e", inboundEventId],
      ],
    });
  });

  it("rejects self messages before crypto", async () => {
    await startBus();
    await emitEvent({ pubkey: BOT_PUBKEY });
    expect(countRejection("self_message")).toBe(1);
    expectDispatchCounts(0, 0, 0);
  });

  it.each([
    ["invalid signatures", false, 2, 0],
    ["per-sender flood", true, 21, 20],
  ] as const)("rate limits %s", async (_name, valid, count, delivered) => {
    mocks.verifyEvent.mockReturnValue(valid);
    const authorizeSender = vi.fn(async () => "allow" as const);
    const policy = valid ? undefined : { rateLimit: rateLimit(1, 10) };
    await startBus({ authorizeSender }, policy);
    for (let i = 0; i < count; i++) {
      await emitEvent({ id: `event-${i}` });
    }
    if (valid) {
      await emitEvent({ id: "event-0" });
    }
    expectDispatchCounts(valid ? count : 1, delivered, delivered);
    expect(authorizeSender).toHaveBeenCalledTimes(delivered);
    expect(countRejection("invalid_signature")).toBe(valid ? 0 : 1);
    expect(countRejection("rate_limited")).toBe(1);
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
    const bus = await startBus({ onMessage, authorizeSender }, { rateLimit: rateLimit(2, 1) });
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
      expect(mocks.decrypt).toHaveBeenCalledTimes(1);
      expect(onMessage).toHaveBeenCalledTimes(1);
      expect(countRejection("rate_limited")).toBe(0);
    } finally {
      blocked.resolve("block");
      await bus.close();
    }
  });

  it("charges oversized ciphertext globally while retaining rejected events in replay overlap", async () => {
    mocks.readNostrBusState.mockResolvedValueOnce({
      version: 2,
      lastProcessedAt: 1_000,
      gatewayStartedAt: 900,
      recentEventIds: [],
    });
    mocks.computeSinceTimestamp.mockReturnValue(1_000);
    const bus = await startBus(
      { ...ACCOUNT, relays: ["wss://relay.example"] },
      { maxCiphertextBytes: 4, rateLimit: rateLimit(1, 10) },
    );
    expect(mocks.writeNostrBusState).toHaveBeenCalledWith(
      expect.objectContaining({ lastProcessedAt: 1_000, gatewayStartedAt: 900 }),
    );
    await emitEvent({
      id: "oversized-durable",
      pubkey: `sender1${"a".repeat(57)}`,
      content: "ciphertext-too-large",
      created_at: 2_000,
    });
    mocks.handlers[0]?.oneose?.();
    await emitEvent({
      id: "oversized-rejected",
      pubkey: `sender2${"b".repeat(57)}`,
      content: "ciphertext-too-large",
      created_at: 900,
    });
    await emitEvent({ id: "later-rejection", created_at: 950 });
    expect(countRejection("oversized_ciphertext")).toBe(1);
    expect(countRejection("rate_limited")).toBe(2);
    expectDispatchCounts(0, 0, 0);
    await bus.close();
    expect(mocks.writeNostrBusState.mock.calls.at(-1)?.[0]?.lastProcessedAt).toBe(1_020);
  });

  it("rejects oversized raw events and ciphertext without closing relays or spending sender budget", async () => {
    await startBus({}, { maxCiphertextBytes: 4, rateLimit: rateLimit(10, 1) });
    await emitEvent({ id: "raw-oversized", content: "x".repeat(40_000) });
    await emitEvent({ id: "oversized-sender-1", content: "ciphertext-too-large" });
    await emitEvent({ id: "oversized-sender-2", content: "ciphertext-too-large" });
    expect(onDelivered).not.toHaveBeenCalled();
    await emitEvent({ id: "allowed-after-oversized", content: "ok" });
    expect(mocks.subscriptionClose).not.toHaveBeenCalled();
    expect(countRejection("oversized_ciphertext")).toBe(2);
    expect(countRejection("rate_limited")).toBe(0);
    expectDispatchCounts(1, 1, 1);
  });

  it("rejects far-future events before crypto", async () => {
    const bus = await startBus();
    await emitEvent({ created_at: Math.floor(Date.now() / 1000) + 600 });
    expect(countRejection("future")).toBe(1);
    expectDispatchCounts(0, 0, 0);
    await bus.close();
    const persisted = mocks.writeNostrBusState.mock.calls.at(-1)?.[0];
    expect(persisted?.lastProcessedAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
  });
});
