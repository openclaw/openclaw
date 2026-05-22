import type { WAMessage } from "baileys";
import { afterEach, describe, expect, it, vi } from "vitest";

type StoredMessage = {
  key?: {
    id?: string;
    remoteJid?: string;
    participant?: string;
    fromMe?: boolean;
  };
  messageTimestamp?: number;
  message?: {
    conversation?: string;
  };
};

type StoredRecord = {
  id: string;
  accountId: string;
  upsertType: "notify" | "append";
  message: StoredMessage;
  receivedAt: number;
};

type TestStore = {
  pending: StoredRecord[];
  completed: Record<string, number | { completedAt: number }>;
};

function cloneStore(store: TestStore): TestStore {
  return structuredClone(store);
}

function makeMessage(id: string): WAMessage {
  return {
    key: {
      id,
      remoteJid: "15551234567@s.whatsapp.net",
      fromMe: false,
    },
    messageTimestamp: 1_779_434_000,
    message: { conversation: `body ${id}` },
  } as unknown as WAMessage;
}

describe("durable inbound queue", () => {
  afterEach(() => {
    vi.doUnmock("openclaw/plugin-sdk/file-lock");
    vi.doUnmock("openclaw/plugin-sdk/json-store");
    vi.resetModules();
  });

  it("serializes overlapping accept and complete writes against one store", async () => {
    vi.resetModules();
    let store: TestStore = { pending: [], completed: {} };
    let overlapPhase = false;
    let overlapWrites = 0;
    let releaseFirstOverlapWrite!: () => void;
    let resolveFirstOverlapWriteBlocked!: () => void;
    const firstOverlapWriteBlocked = new Promise<void>((resolve) => {
      resolveFirstOverlapWriteBlocked = resolve;
    });
    const firstOverlapWriteCanContinue = new Promise<void>((resolve) => {
      releaseFirstOverlapWrite = resolve;
    });

    vi.doMock("openclaw/plugin-sdk/file-lock", () => ({
      withFileLock: async (_filePath: string, _options: unknown, fn: () => Promise<unknown>) =>
        await fn(),
    }));
    vi.doMock("openclaw/plugin-sdk/json-store", () => ({
      readJsonFileWithFallback: vi.fn(async () => ({ value: cloneStore(store), exists: true })),
      writeJsonFileAtomically: vi.fn(async (_filePath: string, value: unknown) => {
        if (overlapPhase) {
          overlapWrites += 1;
          if (overlapWrites === 1) {
            resolveFirstOverlapWriteBlocked();
            await firstOverlapWriteCanContinue;
          }
        }
        store = cloneStore(value as TestStore);
      }),
    }));

    const {
      acceptDurableInboundMessage,
      completeDurableInboundMessage,
      loadPendingDurableInboundMessages,
    } = await import("./durable-queue.js");

    const oldAccepted = await acceptDurableInboundMessage({
      authDir: "/tmp/openclaw-durable-inbound-test",
      accountId: "acct",
      upsertType: "notify",
      message: makeMessage("old"),
    });
    expect(oldAccepted.kind).toBe("accepted");
    if (oldAccepted.kind !== "accepted") {
      throw new Error("old message should be accepted");
    }

    overlapPhase = true;
    const acceptNew = acceptDurableInboundMessage({
      authDir: "/tmp/openclaw-durable-inbound-test",
      accountId: "acct",
      upsertType: "notify",
      message: makeMessage("new"),
    });
    await firstOverlapWriteBlocked;
    const completeOld = completeDurableInboundMessage({
      authDir: "/tmp/openclaw-durable-inbound-test",
      record: oldAccepted.record,
    });
    await new Promise((resolve) => setImmediate(resolve));
    releaseFirstOverlapWrite();
    await Promise.all([acceptNew, completeOld]);

    const pending = await loadPendingDurableInboundMessages({
      authDir: "/tmp/openclaw-durable-inbound-test",
      accountId: "acct",
    });
    expect(pending.map((record) => record.message.key?.id)).toEqual(["new"]);
    expect(store.pending.map((record) => record.message.key?.id)).toEqual(["new"]);
    expect(Object.keys(store.completed)).toHaveLength(1);
  });
});
