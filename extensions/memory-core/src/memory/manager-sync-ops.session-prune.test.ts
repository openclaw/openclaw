// Memory Core tests cover session-row prune safety in manager sync ops: a full
// directory enumeration only prunes indexed session rows when it actually read
// the sessions dir, so a transient scan failure cannot wipe the session index.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  resolveSessionTranscriptsDirForAgent,
  type OpenClawConfig,
  type ResolvedMemorySearchConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryManagerSyncOps } from "./manager-sync-ops.js";

type SourceStateRow = { path: string; hash: string; mtime: number; size: number };

class SessionPruneHarness extends MemoryManagerSyncOps {
  protected readonly cfg = {} as OpenClawConfig;
  protected readonly agentId = "main";
  protected readonly workspaceDir = "/tmp/openclaw-test-workspace";
  protected readonly settings = {
    sync: {
      sessions: {
        deltaBytes: 100_000,
        deltaMessages: 50,
        postCompactionForce: true,
      },
    },
  } as ResolvedMemorySearchConfig;
  protected readonly batch = {
    enabled: false,
    wait: false,
    concurrency: 1,
    pollIntervalMs: 0,
    timeoutMs: 0,
  };
  protected readonly vector = { enabled: false, available: false };
  protected readonly cache = { enabled: false };
  protected providerUnavailableReason?: string;
  protected providerLifecycle = { mode: "active" as const, providerId: "test" };
  protected db: DatabaseSync;

  readonly deletedSessionPaths: string[] = [];

  constructor(sourceRows: SourceStateRow[]) {
    super();
    this.sources.add("sessions");
    this.db = {
      prepare: (sql: string) => ({
        all: () => sourceRows,
        get: () => undefined,
        run: (...args: unknown[]) => {
          if (sql.startsWith("DELETE FROM files")) {
            this.deletedSessionPaths.push(String(args[0]));
          }
          return undefined;
        },
      }),
    } as unknown as DatabaseSync;
  }

  async runFullSessionSync(): Promise<void> {
    await (this as unknown as { syncSessionFiles: (p: unknown) => Promise<void> }).syncSessionFiles(
      {
        needsFullReindex: true,
      },
    );
  }

  protected computeProviderKey(): string {
    return "test";
  }

  protected async sync(): Promise<void> {}

  protected async withTimeout<T>(promise: Promise<T>): Promise<T> {
    return await promise;
  }

  protected getIndexConcurrency(): number {
    return 1;
  }

  protected pruneEmbeddingCacheIfNeeded(): void {}

  protected resetProviderInitializationForRetry(): void {}

  protected assertRequiredProviderAvailable(): void {}

  protected async indexFile(): Promise<void> {}
}

describe("session prune safety", () => {
  let stateDir = "";

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-prune-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("does not prune indexed session rows when the directory scan fails", async () => {
    // The index holds a session row; a transient readdir failure surfaces an
    // empty listing. Without the guard the empty listing would prune the row.
    const harness = new SessionPruneHarness([
      { path: "sessions/main/thread.jsonl", hash: "hash-a", mtime: 1, size: 1 },
    ]);
    vi.spyOn(fs, "readdir").mockRejectedValueOnce(
      Object.assign(new Error("nfs blip"), { code: "EIO" }),
    );

    await harness.runFullSessionSync();

    expect(harness.deletedSessionPaths).toEqual([]);
  });

  it("prunes orphaned session rows when the directory is authoritatively empty", async () => {
    // The directory is read successfully and genuinely holds no session files
    // (e.g. disk-budget removed the last archive). The orphaned row must be
    // pruned rather than lingering in search.
    await fs.mkdir(resolveSessionTranscriptsDirForAgent("main"), { recursive: true });
    const harness = new SessionPruneHarness([
      { path: "sessions/main/gone.jsonl", hash: "hash-gone", mtime: 1, size: 1 },
    ]);

    await harness.runFullSessionSync();

    expect(harness.deletedSessionPaths).toEqual(["sessions/main/gone.jsonl"]);
  });
});
