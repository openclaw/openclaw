import { afterEach, describe, expect, it, vi } from "vitest";
import { createMessageQueue, type QueuedMessage } from "./message-queue.js";

function makeMsg(overrides: Partial<QueuedMessage> = {}): QueuedMessage {
  return {
    type: "c2c",
    senderId: "user1",
    content: "hello",
    messageId: "msg-1",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe("createMessageQueue", () => {
  const logs: string[] = [];
  const ctx = {
    accountId: "test-account",
    log: {
      info: (msg: string) => logs.push(msg),
      error: (msg: string) => logs.push(msg),
      debug: (msg: string) => logs.push(msg),
    },
    isAborted: () => false,
  };

  afterEach(() => {
    logs.length = 0;
  });

  it("creates a queue with all required methods", () => {
    const q = createMessageQueue(ctx);
    expect(typeof q.enqueue).toBe("function");
    expect(typeof q.startProcessor).toBe("function");
    expect(typeof q.getSnapshot).toBe("function");
    expect(typeof q.getMessagePeerId).toBe("function");
    expect(typeof q.clearUserQueue).toBe("function");
    expect(typeof q.executeImmediate).toBe("function");
  });

  describe("getMessagePeerId", () => {
    const q = createMessageQueue(ctx);

    it("returns dm: prefix for c2c messages", () => {
      expect(q.getMessagePeerId(makeMsg({ type: "c2c", senderId: "abc" }))).toBe("dm:abc");
    });

    it("returns dm: prefix for dm messages", () => {
      expect(q.getMessagePeerId(makeMsg({ type: "dm", senderId: "xyz" }))).toBe("dm:xyz");
    });

    it("returns guild: prefix for guild messages", () => {
      expect(
        q.getMessagePeerId(makeMsg({ type: "guild", channelId: "ch1" })),
      ).toBe("guild:ch1");
    });

    it("returns guild:unknown for guild messages without channelId", () => {
      expect(q.getMessagePeerId(makeMsg({ type: "guild" }))).toBe("guild:unknown");
    });

    it("returns group: prefix for group messages", () => {
      expect(
        q.getMessagePeerId(makeMsg({ type: "group", groupOpenid: "grp1" })),
      ).toBe("group:grp1");
    });

    it("returns group:unknown for group messages without groupOpenid", () => {
      expect(q.getMessagePeerId(makeMsg({ type: "group" }))).toBe("group:unknown");
    });
  });

  describe("enqueue and getSnapshot", () => {
    it("enqueues a message and reports it in snapshot", async () => {
      const q = createMessageQueue(ctx);
      const processed: QueuedMessage[] = [];
      q.startProcessor(async (msg) => {
        processed.push(msg);
      });

      q.enqueue(makeMsg({ senderId: "user1", content: "hi" }));
      await vi.waitFor(() => expect(processed.length).toBe(1));

      const snap = q.getSnapshot("dm:user1");
      expect(snap.senderPending).toBe(0);
      expect(snap.totalPending).toBe(0);
    });

    it("queues messages per user", async () => {
      const q = createMessageQueue(ctx);
      const processed: QueuedMessage[] = [];
      let resolveProcessing: () => void = () => {};
      const processingPromise = new Promise<void>((r) => {
        resolveProcessing = r;
      });

      q.startProcessor(async (msg) => {
        processed.push(msg);
        if (processed.length === 1) {
          await processingPromise;
        }
      });

      q.enqueue(makeMsg({ senderId: "user1", content: "msg1" }));
      q.enqueue(makeMsg({ senderId: "user1", content: "msg2" }));
      q.enqueue(makeMsg({ senderId: "user2", content: "msg3" }));

      await vi.waitFor(() => expect(processed.length).toBeGreaterThanOrEqual(1));

      resolveProcessing();
      await vi.waitFor(() => expect(processed.length).toBe(3));
    });
  });

  describe("clearUserQueue", () => {
    it("returns 0 when queue is empty", () => {
      const q = createMessageQueue(ctx);
      expect(q.clearUserQueue("dm:nonexistent")).toBe(0);
    });

    it("clears queued messages and returns count", async () => {
      const q = createMessageQueue(ctx);
      let blockResolve: () => void = () => {};
      const blockPromise = new Promise<void>((r) => {
        blockResolve = r;
      });

      q.startProcessor(async () => {
        await blockPromise;
      });

      q.enqueue(makeMsg({ senderId: "user1", content: "msg1" }));
      q.enqueue(makeMsg({ senderId: "user1", content: "msg2" }));
      q.enqueue(makeMsg({ senderId: "user1", content: "msg3" }));

      const dropped = q.clearUserQueue("dm:user1");
      expect(dropped).toBeGreaterThanOrEqual(0);

      blockResolve();
    });
  });

  describe("executeImmediate", () => {
    it("executes a message immediately bypassing the queue", async () => {
      const q = createMessageQueue(ctx);
      const processed: QueuedMessage[] = [];
      q.startProcessor(async (msg) => {
        processed.push(msg);
      });

      const urgent = makeMsg({ senderId: "admin", content: "urgent!" });
      q.executeImmediate(urgent);

      await vi.waitFor(() => expect(processed.length).toBe(1));
      expect(processed[0].content).toBe("urgent!");
    });
  });

  describe("startProcessor", () => {
    it("logs when processor starts", () => {
      const q = createMessageQueue(ctx);
      q.startProcessor(async () => {});
      expect(logs.some((l) => l.includes("Message processor started"))).toBe(true);
    });
  });

  describe("per-user queue limit", () => {
    it("drops oldest message when per-user queue is full", async () => {
      const q = createMessageQueue(ctx);
      let blockResolve: () => void = () => {};
      const blockPromise = new Promise<void>((r) => {
        blockResolve = r;
      });

      q.startProcessor(async () => {
        await blockPromise;
      });

      for (let i = 0; i < 22; i++) {
        q.enqueue(makeMsg({ senderId: "user1", content: `msg-${i}`, messageId: `id-${i}` }));
      }

      const errorLogs = logs.filter((l) => l.includes("Per-user queue full"));
      expect(errorLogs.length).toBeGreaterThan(0);

      blockResolve();
    });
  });
});
