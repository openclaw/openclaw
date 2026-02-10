import { describe, expect, test, vi } from "vitest";
import type { WecomInboundMessage } from "../types.js";
import type { WecomWebhookTarget } from "./types.js";
import { StreamStore } from "./state.js";

describe("wecom StreamStore queue", () => {
  test("does not merge into active batch; flushes queued batch after active finishes", async () => {
    vi.useFakeTimers();
    try {
      const store = new StreamStore();
      const flushed: string[] = [];
      store.setFlushHandler((pending) => flushed.push(pending.streamId));

      const target = {
        account: {} as any,
        config: {} as any,
        runtime: {},
        core: {} as any,
        path: "/wecom",
      } satisfies WecomWebhookTarget;

      const conversationKey = "wecom:default:U:C";

      const msg1 = { msgid: "M1" } satisfies WecomInboundMessage;
      const msg2 = { msgid: "M2" } satisfies WecomInboundMessage;

      const r1 = store.addPendingMessage({
        conversationKey,
        target,
        msg: msg1,
        msgContent: "1",
        nonce: "n",
        timestamp: "t",
        debounceMs: 10,
      });
      const r2 = store.addPendingMessage({
        conversationKey,
        target,
        msg: msg2,
        msgContent: "2",
        nonce: "n",
        timestamp: "t",
        debounceMs: 10,
      });

      expect(r1.status).toBe("active_new");
      // 初始批次不接收合并：第二条进入 queued
      expect(r2.status).toBe("queued_new");
      expect(r2.streamId).not.toBe(r1.streamId);

      // Follow-ups within queued should merge into queued (status queued_merged).
      const r3 = store.addPendingMessage({
        conversationKey,
        target,
        msg: { msgid: "M3" } as any,
        msgContent: "3",
        nonce: "n",
        timestamp: "t",
        debounceMs: 10,
      });
      expect(r3.status).toBe("queued_merged");
      expect(r3.streamId).toBe(r2.streamId);

      // Active batch flushes at debounce time.
      await vi.advanceTimersByTimeAsync(11);
      expect(flushed).toEqual([r1.streamId]);

      // Queued batch timer also fires, but cannot flush until active finishes.
      await vi.advanceTimersByTimeAsync(11);
      expect(flushed).toEqual([r1.streamId]);

      // Once the active stream finishes, queued batch is promoted and flushes immediately.
      store.onStreamFinished(r1.streamId);
      expect(flushed).toEqual([r1.streamId, r2.streamId]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("merges into active batch when it has not started yet (even after promotion)", async () => {
    vi.useFakeTimers();
    try {
      const store = new StreamStore();
      const flushed: string[] = [];
      store.setFlushHandler((pending) => flushed.push(pending.streamId));

      const target = {
        account: {} as any,
        config: {} as any,
        runtime: {},
        core: {} as any,
        path: "/wecom",
      } satisfies WecomWebhookTarget;

      const conversationKey = "wecom:default:U:C2";

      // 1 becomes active and flushes; mark as started to simulate "processing started".
      const r1 = store.addPendingMessage({
        conversationKey,
        target,
        msg: { msgid: "M1" } as any,
        msgContent: "1",
        nonce: "n",
        timestamp: "t",
        debounceMs: 10,
      });
      store.markStarted(r1.streamId);
      await vi.advanceTimersByTimeAsync(11);
      expect(flushed).toEqual([r1.streamId]);

      // 2 enters queued with a longer debounce; it should NOT become readyToFlush yet.
      const r2 = store.addPendingMessage({
        conversationKey,
        target,
        msg: { msgid: "M2" } as any,
        msgContent: "2",
        nonce: "n",
        timestamp: "t",
        debounceMs: 100,
      });
      expect(flushed).toEqual([r1.streamId]);

      // Finish 1, promote 2 to active (but do NOT flush immediately since it's not readyToFlush).
      store.onStreamFinished(r1.streamId);
      expect(flushed).toEqual([r1.streamId]);

      // Now 2 is active, but (in real monitor) it may still be in debounce before markStarted.
      // We simulate that by NOT calling markStarted. Follow-up should merge into active (same streamId).
      const r3 = store.addPendingMessage({
        conversationKey,
        target,
        msg: { msgid: "M3" } as any,
        msgContent: "3",
        nonce: "n",
        timestamp: "t",
        debounceMs: 10,
      });
      expect(r3.streamId).toBe(r2.streamId);
      expect(r3.status).toBe("active_merged");
    } finally {
      vi.useRealTimers();
    }
  });

  test("clears conversation state when idle so next message becomes active", async () => {
    const store = new StreamStore();
    store.setFlushHandler(() => {});

    const target = {
      account: {} as any,
      config: {} as any,
      runtime: {},
      core: {} as any,
      path: "/wecom",
    } satisfies WecomWebhookTarget;

    const conversationKey = "wecom:default:U:idle";

    const r1 = store.addPendingMessage({
      conversationKey,
      target,
      msg: { msgid: "M1" } as any,
      msgContent: "1",
      nonce: "n",
      timestamp: "t",
      debounceMs: 10,
    });
    store.markStarted(r1.streamId);
    store.markFinished(r1.streamId);
    store.onStreamFinished(r1.streamId);

    const r2 = store.addPendingMessage({
      conversationKey,
      target,
      msg: { msgid: "M2" } as any,
      msgContent: "2",
      nonce: "n",
      timestamp: "t",
      debounceMs: 10,
    });
    expect(r2.status).toBe("active_new");
    expect(r2.streamId).not.toBe(r1.streamId);
  });
});
