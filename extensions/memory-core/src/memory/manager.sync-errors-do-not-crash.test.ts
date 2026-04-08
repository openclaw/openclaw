import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runDetachedMemorySync, MemoryManagerSyncOps } from "./manager-sync-ops.js";

class TestMemoryManagerSyncOps extends MemoryManagerSyncOps {
  protected readonly cfg = {} as never;
  protected readonly agentId = "main";
  protected readonly workspaceDir = os.tmpdir();
  protected readonly settings = {
    sync: { sessions: { deltaBytes: 1, deltaMessages: 0 } },
    chunking: { size: 512, overlap: 0 },
    store: { fts: { tokenizer: "unicode61" } },
  } as never;
  protected provider = null;
  protected readonly batch = {
    enabled: false,
    wait: false,
    concurrency: 1,
    pollIntervalMs: 10,
    timeoutMs: 10,
  };
  protected readonly vector = {
    enabled: false,
    available: false,
  };
  protected readonly cache = { enabled: false };
  protected db = {} as never;
  readonly syncSpy = vi.fn(async () => {});

  protected computeProviderKey(): string {
    return "test";
  }
  protected async sync(): Promise<void> {
    await this.syncSpy();
  }
  protected async withTimeout<T>(promise: Promise<T>): Promise<T> {
    return promise;
  }
  protected getIndexConcurrency(): number {
    return 1;
  }
  protected pruneEmbeddingCacheIfNeeded(): void {}
  protected async indexFile(): Promise<void> {}
}

describe("memory manager sync failures", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
  });

  it("does not raise unhandledRejection when watch-triggered sync fails", async () => {
    const unhandled: unknown[] = [];
    const handler = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", handler);
    const syncSpy = vi
      .fn()
      .mockRejectedValueOnce(new Error("openai embeddings failed: 400 bad request"));
    setTimeout(() => {
      runDetachedMemorySync(syncSpy, "watch");
    }, 1);

    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
    await syncSpy.mock.results[0]?.value?.catch(() => undefined);

    process.off("unhandledRejection", handler);
    expect(unhandled).toHaveLength(0);
  });

  it("retries session-delta sync after fetch failures without losing pending session work", async () => {
    const manager = new TestMemoryManagerSyncOps();
    manager.syncSpy.mockRejectedValueOnce(new Error("TypeError: fetch failed")).mockResolvedValueOnce(undefined);

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-delta-"));
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(sessionFile, '{"role":"user","content":"hello"}\n', "utf8");
    (manager as unknown as { sessionPendingFiles: Set<string> }).sessionPendingFiles.add(sessionFile);

    await (manager as unknown as { processSessionDeltaBatch: () => Promise<void> }).processSessionDeltaBatch();
    await vi.runAllTicks();

    expect(manager.syncSpy).toHaveBeenCalledTimes(1);
    expect(
      (manager as unknown as { sessionPendingFiles: Set<string> }).sessionPendingFiles.has(sessionFile),
    ).toBe(true);
    expect(
      (manager as unknown as { sessionWatchTimer: NodeJS.Timeout | null }).sessionWatchTimer,
    ).not.toBeNull();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(manager.syncSpy).toHaveBeenCalledTimes(2);
  });
});
