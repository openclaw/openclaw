import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { MemorySyncParams } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { describe, expect, it, vi } from "vitest";
import { MemoryTargetedSessionSyncQueue } from "./manager-sync-control.js";

function createQueuedSyncHarness(archiveFiles: string[] = []) {
  const active = createDeferred<void>();
  let closed = false;
  const sync = vi.fn(async (_params?: MemorySyncParams) => {});
  const queue = new MemoryTargetedSessionSyncQueue({
    isClosed: () => closed,
    getSyncing: () => active.promise,
    sync,
  });
  for (const file of archiveFiles) {
    queue.archiveFiles.add(file);
  }
  return {
    queue,
    pendingSync: active.promise,
    releaseSync: () => active.resolve(),
    setClosed(value: boolean) {
      closed = value;
    },
    sync,
  };
}

const session = (sessionId: string) => ({
  agentId: "main",
  sessionId,
  sessionKey: `agent:main:${sessionId}`,
});
function expectCleared(queue: MemoryTargetedSessionSyncQueue) {
  expect([queue.archiveFiles.size, queue.sessions.size, queue.progressCallbacks.size]).toEqual([
    0, 0, 0,
  ]);
  expect(queue.force).toBe(false);
  expect(queue.pending).toBeNull();
}

describe("memory manager sync control", () => {
  it("merges repeated queued requests while the active sync is still running", async () => {
    const harness = createQueuedSyncHarness();

    const first = harness.queue.enqueue({
      archiveFiles: ["/tmp/first.jsonl", "/tmp/second.jsonl"],
    });
    const second = harness.queue.enqueue({
      archiveFiles: ["/tmp/second.jsonl", "/tmp/third.jsonl"],
    });

    expect(first).toBe(second);
    harness.releaseSync();
    await second;

    expect(harness.sync).toHaveBeenCalledTimes(1);
    expect(harness.sync).toHaveBeenCalledWith({
      reason: "queued-sessions",
      sessions: [],
      archiveFiles: ["/tmp/first.jsonl", "/tmp/second.jsonl", "/tmp/third.jsonl"],
    });
  });

  it("falls back to the active sync when no usable session files were queued", async () => {
    const harness = createQueuedSyncHarness();

    const queued = harness.queue.enqueue({
      archiveFiles: ["", "   "],
    });

    expect(queued).toBe(harness.pendingSync);
    harness.releaseSync();
    await queued;
    expect(harness.sync).not.toHaveBeenCalled();
  });

  it("queues identity session targets while a sync is already running", async () => {
    const harness = createQueuedSyncHarness();
    const progressUpdate = { completed: 1, total: 2, label: "queued" };
    const progress = vi.fn();
    harness.sync.mockImplementationOnce(async (params) => {
      params?.progress?.(progressUpdate);
    });

    const queued = harness.queue.enqueue({
      sessions: [session("targeted")],
      force: true,
      progress,
    });

    harness.releaseSync();
    await queued;

    expect(harness.sync).toHaveBeenCalledWith({
      reason: "queued-sessions",
      force: true,
      sessions: [session("targeted")],
      archiveFiles: [],
      progress: expect.any(Function),
    });
    expect(progress).toHaveBeenCalledWith(progressUpdate);
  });

  it("keeps failed queued targets for a later retry", async () => {
    const queuedSync = createDeferred<void>();
    const harness = createQueuedSyncHarness();
    harness.sync.mockReturnValueOnce(queuedSync.promise).mockResolvedValueOnce(undefined);

    const firstProgress = vi.fn();
    const first = harness.queue.enqueue({
      sessions: [session("first")],
      archiveFiles: ["/tmp/first.jsonl"],
      force: true,
      progress: firstProgress,
    });
    const firstRejection = expect(first).rejects.toThrow("transient sqlite failure");

    harness.releaseSync();
    await vi.waitFor(() => {
      expect(harness.sync).toHaveBeenCalledTimes(1);
    });

    const concurrentProgress = vi.fn();
    const concurrent = harness.queue.enqueue({
      sessions: [session("second")],
      archiveFiles: ["/tmp/second.jsonl"],
      progress: concurrentProgress,
    });
    expect(concurrent).toBe(first);

    queuedSync.reject(new Error("transient sqlite failure"));
    await firstRejection;

    expect(harness.queue.archiveFiles).toEqual(new Set(["/tmp/second.jsonl", "/tmp/first.jsonl"]));
    expect(Array.from(harness.queue.sessions.values())).toEqual([
      session("second"),
      session("first"),
    ]);
    expect(harness.queue.pending).toBeNull();
    expect(harness.queue.progressCallbacks.size).toBe(0);
    expect(harness.queue.force).toBe(true);

    await harness.queue.enqueue();

    expect(harness.sync).toHaveBeenCalledTimes(2);
    expect(harness.sync).toHaveBeenLastCalledWith({
      reason: "queued-sessions",
      force: true,
      sessions: [session("second"), session("first")],
      archiveFiles: ["/tmp/second.jsonl", "/tmp/first.jsonl"],
    });
    expectCleared(harness.queue);
  });

  it("clears queued state when the manager closes while the queue waits", async () => {
    const harness = createQueuedSyncHarness(["/tmp/close-retained.jsonl"]);
    const progress = vi.fn();

    const queued = harness.queue.enqueue({
      sessions: [session("close")],
      force: true,
      progress,
    });

    harness.setClosed(true);
    harness.releaseSync();
    await queued;

    expect(harness.sync).not.toHaveBeenCalled();
    expectCleared(harness.queue);
  });
});
