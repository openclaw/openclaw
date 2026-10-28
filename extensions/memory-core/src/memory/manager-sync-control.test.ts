import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { MemorySyncParams } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { MemoryTargetedSessionSyncQueue } from "./manager-sync-control.js";

let active: ReturnType<typeof createDeferred<void>>;
let closed: boolean;
let sync: Mock<(params?: MemorySyncParams) => Promise<void>>;
let queue: MemoryTargetedSessionSyncQueue;
beforeEach(() => {
  active = createDeferred<void>();
  closed = false;
  sync = vi.fn(async (_params?: MemorySyncParams) => {});
  queue = new MemoryTargetedSessionSyncQueue({
    isClosed: () => closed,
    getSyncing: () => active.promise,
    sync,
  });
});

const session = (sessionId: string) => ({
  agentId: "main",
  sessionId,
  sessionKey: `agent:main:${sessionId}`,
});
const archives = (...ids: string[]) => ids.map((id) => `/tmp/${id}.jsonl`);
const targets = (...ids: string[]) => ({
  sessions: ids.map(session),
  archiveFiles: archives(...ids),
});
function expectCleared() {
  expect(queue).toMatchObject({
    archiveFiles: { size: 0 },
    sessions: { size: 0 },
    progressCallbacks: { size: 0 },
    force: false,
    pending: null,
  });
}

describe("memory manager sync control", () => {
  it("merges repeated queued requests while the active sync is still running", async () => {
    const first = queue.enqueue({ archiveFiles: archives("first", "second") });
    const second = queue.enqueue({ archiveFiles: archives("second", "third") });

    expect(first).toBe(second);
    active.resolve();
    await second;

    const expected = {
      reason: "queued-sessions",
      sessions: [],
      archiveFiles: archives("first", "second", "third"),
    };
    expect(sync.mock.calls).toEqual([[expected]]);
  });

  it("falls back to the active sync when no usable session files were queued", async () => {
    const queued = queue.enqueue({ archiveFiles: ["", "   "] });

    expect(queued).toBe(active.promise);
    active.resolve();
    await queued;
    expect(sync).not.toHaveBeenCalled();
  });

  it("queues identity session targets while a sync is already running", async () => {
    const progressUpdate = { completed: 1, total: 2, label: "queued" };
    const progress = vi.fn();
    sync.mockImplementationOnce(async (params) => {
      params?.progress?.(progressUpdate);
    });

    const queued = queue.enqueue({
      sessions: [session("targeted")],
      force: true,
      progress,
    });

    active.resolve();
    await queued;

    expect(sync).toHaveBeenCalledWith({
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
    sync.mockReturnValueOnce(queuedSync.promise).mockResolvedValueOnce(undefined);

    const first = queue.enqueue({ ...targets("first"), force: true, progress: vi.fn() });
    const firstRejection = expect(first).rejects.toThrow("transient sqlite failure");

    active.resolve();
    await vi.waitFor(() => {
      expect(sync).toHaveBeenCalledTimes(1);
    });

    const concurrent = queue.enqueue({ ...targets("second"), progress: vi.fn() });
    expect(concurrent).toBe(first);

    queuedSync.reject(new Error("transient sqlite failure"));
    await firstRejection;

    expect(queue.archiveFiles).toEqual(new Set(["/tmp/second.jsonl", "/tmp/first.jsonl"]));
    expect(Array.from(queue.sessions.values())).toEqual([session("second"), session("first")]);
    expect(queue).toMatchObject({ pending: null, progressCallbacks: { size: 0 }, force: true });

    await queue.enqueue();

    expect(sync).toHaveBeenCalledTimes(2);
    expect(sync).toHaveBeenLastCalledWith({
      reason: "queued-sessions",
      force: true,
      ...targets("second", "first"),
    });
    expectCleared();
  });

  it("clears queued state when the manager closes while the queue waits", async () => {
    queue.archiveFiles.add("/tmp/close-retained.jsonl");
    const queued = queue.enqueue({ sessions: [session("close")], force: true, progress: vi.fn() });

    closed = true;
    active.resolve();
    await queued;

    expect(sync).not.toHaveBeenCalled();
    expectCleared();
  });
});
