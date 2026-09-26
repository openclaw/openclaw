// Memory Core tests cover manager sync control plugin behavior.
import type { MemorySyncParams } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { describe, expect, it, vi } from "vitest";
import { MemoryTargetedSessionSyncQueue } from "./manager-sync-control.js";

function createQueuedSyncHarness(params: { syncing: Promise<void>; archiveFiles?: string[] }) {
  let closed = false;
  const sync = vi.fn(async (_params?: MemorySyncParams) => {});
  const queue = new MemoryTargetedSessionSyncQueue({
    isClosed: () => closed,
    getSyncing: () => params.syncing,
    sync,
  });
  for (const file of params.archiveFiles ?? []) {
    queue.archiveFiles.add(file);
  }
  return {
    queue,
    setClosed(value: boolean) {
      closed = value;
    },
    sync,
  };
}

describe("memory manager sync control", () => {
  it("queues targeted session files behind an in-flight sync", async () => {
    let releaseSync = () => {};
    const pendingSync = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    const harness = createQueuedSyncHarness({ syncing: pendingSync });

    const queued = harness.queue.enqueue({
      archiveFiles: ["  /tmp/first.jsonl ", "", "/tmp/second.jsonl"],
    });

    expect(harness.sync).not.toHaveBeenCalled();
    releaseSync();
    await queued;

    expect(harness.sync).toHaveBeenCalledTimes(1);
    expect(harness.sync).toHaveBeenCalledWith({
      reason: "queued-sessions",
      sessions: [],
      archiveFiles: ["/tmp/first.jsonl", "/tmp/second.jsonl"],
    });
    expect(harness.queue.pending).toBeNull();
  });

  it("merges repeated queued requests while the active sync is still running", async () => {
    let releaseSync = () => {};
    const pendingSync = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    const harness = createQueuedSyncHarness({ syncing: pendingSync });

    const first = harness.queue.enqueue({
      archiveFiles: ["/tmp/first.jsonl", "/tmp/second.jsonl"],
    });
    const second = harness.queue.enqueue({
      archiveFiles: ["/tmp/second.jsonl", "/tmp/third.jsonl"],
    });

    expect(first).toBe(second);
    releaseSync();
    await second;

    expect(harness.sync).toHaveBeenCalledTimes(1);
    expect(harness.sync).toHaveBeenCalledWith({
      reason: "queued-sessions",
      sessions: [],
      archiveFiles: ["/tmp/first.jsonl", "/tmp/second.jsonl", "/tmp/third.jsonl"],
    });
  });

  it("falls back to the active sync when no usable session files were queued", async () => {
    let releaseSync = () => {};
    const pendingSync = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    const harness = createQueuedSyncHarness({ syncing: pendingSync });

    const queued = harness.queue.enqueue({
      archiveFiles: ["", "   "],
    });

    expect(queued).toBe(pendingSync);
    releaseSync();
    await queued;
    expect(harness.sync).not.toHaveBeenCalled();
  });

  it("queues identity session targets while a sync is already running", async () => {
    let releaseSync = () => {};
    const pendingSync = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    const harness = createQueuedSyncHarness({ syncing: pendingSync });
    const progressUpdate = { completed: 1, total: 2, label: "queued" };
    const progress = vi.fn();
    harness.sync.mockImplementationOnce(async (params) => {
      params?.progress?.(progressUpdate);
    });

    const queued = harness.queue.enqueue({
      sessions: [{ agentId: "main", sessionId: "targeted", sessionKey: "agent:main:targeted" }],
      force: true,
      progress,
    });

    releaseSync();
    await queued;

    expect(harness.sync).toHaveBeenCalledWith({
      reason: "queued-sessions",
      force: true,
      sessions: [{ agentId: "main", sessionId: "targeted", sessionKey: "agent:main:targeted" }],
      archiveFiles: [],
      progress: expect.any(Function),
    });
    expect(progress).toHaveBeenCalledWith(progressUpdate);
  });

  it("keeps failed queued targets for a later retry", async () => {
    let releaseSync = () => {};
    const pendingSync = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    let rejectQueuedSync: ((error: Error) => void) | undefined;
    const queuedSync = new Promise<void>((_resolve, reject) => {
      rejectQueuedSync = reject;
    });
    const harness = createQueuedSyncHarness({ syncing: pendingSync });
    harness.sync.mockReturnValueOnce(queuedSync).mockResolvedValueOnce(undefined);

    const firstProgress = vi.fn();
    const first = harness.queue.enqueue({
      sessions: [{ agentId: "main", sessionId: "first", sessionKey: "agent:main:first" }],
      archiveFiles: ["/tmp/first.jsonl"],
      force: true,
      progress: firstProgress,
    });
    const firstRejection = expect(first).rejects.toThrow("transient sqlite failure");

    releaseSync();
    await vi.waitFor(() => {
      expect(harness.sync).toHaveBeenCalledTimes(1);
    });

    const concurrentProgress = vi.fn();
    const concurrent = harness.queue.enqueue({
      sessions: [{ agentId: "main", sessionId: "second", sessionKey: "agent:main:second" }],
      archiveFiles: ["/tmp/second.jsonl"],
      progress: concurrentProgress,
    });
    expect(concurrent).toBe(first);

    rejectQueuedSync?.(new Error("transient sqlite failure"));
    await firstRejection;

    expect(harness.queue.archiveFiles).toEqual(new Set(["/tmp/second.jsonl", "/tmp/first.jsonl"]));
    expect(Array.from(harness.queue.sessions.values())).toEqual([
      { agentId: "main", sessionId: "second", sessionKey: "agent:main:second" },
      { agentId: "main", sessionId: "first", sessionKey: "agent:main:first" },
    ]);
    expect(harness.queue.pending).toBeNull();
    expect(harness.queue.progressCallbacks.size).toBe(0);
    expect(harness.queue.force).toBe(true);

    await harness.queue.enqueue();

    expect(harness.sync).toHaveBeenCalledTimes(2);
    expect(harness.sync).toHaveBeenLastCalledWith({
      reason: "queued-sessions",
      force: true,
      sessions: [
        { agentId: "main", sessionId: "second", sessionKey: "agent:main:second" },
        { agentId: "main", sessionId: "first", sessionKey: "agent:main:first" },
      ],
      archiveFiles: ["/tmp/second.jsonl", "/tmp/first.jsonl"],
    });
    expect(harness.queue.archiveFiles.size).toBe(0);
    expect(harness.queue.sessions.size).toBe(0);
    expect(harness.queue.pending).toBeNull();
    expect(harness.queue.force).toBe(false);
  });

  it("clears queued state when the manager closes while the queue waits", async () => {
    let releaseSync = () => {};
    const pendingSync = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    const harness = createQueuedSyncHarness({
      syncing: pendingSync,
      archiveFiles: ["/tmp/close-retained.jsonl"],
    });
    const progress = vi.fn();

    const queued = harness.queue.enqueue({
      sessions: [{ agentId: "main", sessionId: "close", sessionKey: "agent:main:close" }],
      force: true,
      progress,
    });

    harness.setClosed(true);
    releaseSync();
    await queued;

    expect(harness.sync).not.toHaveBeenCalled();
    expect(harness.queue.archiveFiles.size).toBe(0);
    expect(harness.queue.sessions.size).toBe(0);
    expect(harness.queue.progressCallbacks.size).toBe(0);
    expect(harness.queue.force).toBe(false);
    expect(harness.queue.pending).toBeNull();
  });
});
