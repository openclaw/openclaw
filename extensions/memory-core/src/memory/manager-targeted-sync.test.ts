import type { MemorySessionSyncTarget } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { describe, expect, it, vi } from "vitest";
import { enqueueMemoryTargetedSessionSync } from "./manager-sync-control.js";
import {
  clearMemorySyncedSessionFiles,
  runMemoryTargetedSessionSync,
} from "./manager-targeted-sync.js";

describe("memory targeted session sync", () => {
  it("preserves unrelated dirty sessions after targeted cleanup", () => {
    const secondSessionPath = "/tmp/targeted-dirty-second.jsonl";
    const sessionsDirtyFiles = new Set(["/tmp/targeted-dirty-first.jsonl", secondSessionPath]);

    const sessionsDirty = clearMemorySyncedSessionFiles({
      sessionsDirtyFiles,
      targetSessionFiles: ["/tmp/targeted-dirty-first.jsonl"],
    });

    expect(sessionsDirtyFiles.has(secondSessionPath)).toBe(true);
    expect(sessionsDirty).toBe(true);
  });

  it("runs a full reindex after fallback activates during targeted sync", async () => {
    const activateFallbackProvider = vi.fn(async () => true);
    const runSafeReindex = vi.fn(async () => {});
    const runUnsafeReindex = vi.fn(async () => {});

    await runMemoryTargetedSessionSync({
      hasSessionSource: true,
      targetSessionFiles: new Set(["/tmp/targeted-fallback.jsonl"]),
      reason: "post-compaction",
      progress: undefined,
      useUnsafeReindex: false,
      sessionsDirtyFiles: new Set(),
      syncSessionFiles: async () => {
        throw new Error("embedding backend failed");
      },
      shouldFallbackOnError: () => true,
      activateFallbackProvider,
      runSafeReindex,
      runUnsafeReindex,
    });

    expect(activateFallbackProvider).toHaveBeenCalledWith("embedding backend failed");
    expect(runSafeReindex).toHaveBeenCalledWith({
      reason: "post-compaction",
      force: true,
      progress: undefined,
    });
    expect(runUnsafeReindex).not.toHaveBeenCalled();
  });

  it("uses the unsafe reindex path when enabled", async () => {
    const runSafeReindex = vi.fn(async () => {});
    const runUnsafeReindex = vi.fn(async () => {});

    await runMemoryTargetedSessionSync({
      hasSessionSource: true,
      targetSessionFiles: new Set(["/tmp/targeted-fallback.jsonl"]),
      reason: "post-compaction",
      progress: undefined,
      useUnsafeReindex: true,
      sessionsDirtyFiles: new Set(),
      syncSessionFiles: async () => {
        throw new Error("embedding backend failed");
      },
      shouldFallbackOnError: () => true,
      activateFallbackProvider: async () => true,
      runSafeReindex,
      runUnsafeReindex,
    });

    expect(runUnsafeReindex).toHaveBeenCalledWith({
      reason: "post-compaction",
      force: true,
      progress: undefined,
    });
    expect(runSafeReindex).not.toHaveBeenCalled();
  });

  it("queues identity session targets while a sync is already running", async () => {
    let resolveSyncing: (() => void) | undefined;
    const syncing = new Promise<void>((resolve) => {
      resolveSyncing = resolve;
    });
    const queuedSessionFiles = new Set<string>();
    const queuedSessions = new Map<string, MemorySessionSyncTarget>();
    let queuedSessionSync: Promise<void> | null = null;
    const sync = vi.fn(async () => {});

    const queued = enqueueMemoryTargetedSessionSync(
      {
        isClosed: () => false,
        getSyncing: () => syncing,
        getQueuedSessionFiles: () => queuedSessionFiles,
        getQueuedSessions: () => queuedSessions,
        getQueuedSessionSync: () => queuedSessionSync,
        setQueuedSessionSync: (value) => {
          queuedSessionSync = value;
        },
        sync,
      },
      {
        sessions: [{ agentId: "main", sessionId: "targeted", sessionKey: "agent:main:targeted" }],
      },
    );

    resolveSyncing?.();
    await queued;

    expect(sync).toHaveBeenCalledWith({
      reason: "queued-sessions",
      sessions: [{ agentId: "main", sessionId: "targeted", sessionKey: "agent:main:targeted" }],
      sessionFiles: [],
    });
  });
});
