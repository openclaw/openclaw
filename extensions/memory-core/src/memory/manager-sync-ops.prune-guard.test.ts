// Memory Core tests cover stale-row prune safety in manager sync ops: a full
// enumeration only prunes indexed rows when it actually read the source roots,
// so a transient scan failure cannot wipe the session or memory-file index.
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
type SourceSyncPlanResult = { scanOk: boolean };

class PruneGuardHarness extends MemoryManagerSyncOps {
  protected readonly cfg = {} as OpenClawConfig;
  protected readonly agentId = "main";
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

  readonly deletedRows: Array<{ path: string; source: string }> = [];

  constructor(
    sourceRows: SourceStateRow[],
    protected readonly workspaceDir = "/tmp/openclaw-test-workspace",
  ) {
    super();
    this.sources.add("sessions");
    this.sources.add("memory");
    this.db = {
      prepare: (sql: string) => ({
        all: () => sourceRows,
        get: () => undefined,
        run: (...args: unknown[]) => {
          if (sql.startsWith("DELETE FROM files")) {
            this.deletedRows.push({ path: String(args[0]), source: String(args[1]) });
          }
          return undefined;
        },
      }),
    } as unknown as DatabaseSync;
  }

  async runFullSessionSync(): Promise<SourceSyncPlanResult> {
    return await (
      this as unknown as {
        syncSessionFiles: (p: unknown) => Promise<SourceSyncPlanResult>;
      }
    ).syncSessionFiles({ needsFullReindex: true });
  }

  async runFullMemorySync(): Promise<SourceSyncPlanResult> {
    return await (
      this as unknown as {
        syncMemoryFiles: (p: unknown) => Promise<SourceSyncPlanResult>;
      }
    ).syncMemoryFiles({ needsFullReindex: true });
  }

  deletedPathsFor(source: string): string[] {
    return this.deletedRows.filter((row) => row.source === source).map((row) => row.path);
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
    await fs.mkdir(resolveSessionTranscriptsDirForAgent("main"), { recursive: true });
    const harness = new PruneGuardHarness([
      { path: "sessions/main/thread.jsonl", hash: "hash-a", mtime: 1, size: 1 },
    ]);
    vi.spyOn(fs, "readdir").mockRejectedValueOnce(
      Object.assign(new Error("nfs blip"), { code: "EIO" }),
    );

    const plan = await harness.runFullSessionSync();

    expect(plan.scanOk).toBe(false);
    expect(harness.deletedPathsFor("sessions")).toEqual([]);
  });

  it("prunes orphaned session rows when the directory is authoritatively empty", async () => {
    // The directory is read successfully and genuinely holds no session files
    // (e.g. disk-budget removed the last archive). The orphaned row must be
    // pruned rather than lingering in search.
    await fs.mkdir(resolveSessionTranscriptsDirForAgent("main"), { recursive: true });
    const harness = new PruneGuardHarness([
      { path: "sessions/main/gone.jsonl", hash: "hash-gone", mtime: 1, size: 1 },
    ]);

    const plan = await harness.runFullSessionSync();

    expect(plan.scanOk).toBe(true);
    expect(harness.deletedPathsFor("sessions")).toEqual(["sessions/main/gone.jsonl"]);
  });

  it("prunes orphaned session rows when the sessions directory is absent", async () => {
    // The dir only exists once a transcript is written, so ENOENT under an
    // existing agent dir is an authoritative empty enumeration (fresh agent,
    // or the dir was removed wholesale) and orphaned rows must still be
    // pruned.
    await fs.mkdir(path.join(stateDir, "agents", "main"), { recursive: true });
    const harness = new PruneGuardHarness([
      { path: "sessions/main/gone.jsonl", hash: "hash-gone", mtime: 1, size: 1 },
    ]);

    const plan = await harness.runFullSessionSync();

    expect(plan.scanOk).toBe(true);
    expect(harness.deletedPathsFor("sessions")).toEqual(["sessions/main/gone.jsonl"]);
  });
});

describe("memory-file prune safety", () => {
  let stateDir = "";

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-prune-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("does not prune indexed memory rows when the enumeration fails", async () => {
    const workspaceDir = path.join(stateDir, "workspace");
    const memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    const harness = new PruneGuardHarness(
      [{ path: "memory/notes.md", hash: "hash-notes", mtime: 1, size: 1 }],
      workspaceDir,
    );
    const realLstat = fs.lstat;
    vi.spyOn(fs, "lstat").mockImplementation(async (...args: Parameters<typeof realLstat>) => {
      const [target] = args;
      if (typeof target === "string" && path.resolve(target) === memoryDir) {
        throw Object.assign(new Error("nfs blip"), { code: "EIO" });
      }
      return await realLstat(...args);
    });

    const plan = await harness.runFullMemorySync();

    expect(plan.scanOk).toBe(false);
    expect(harness.deletedPathsFor("memory")).toEqual([]);
  });

  it("prunes orphaned memory rows when the workspace holds no memory files", async () => {
    // The workspace exists but has no root memory file and no memory dir; the
    // enumeration is authoritative, so the orphaned row must be pruned.
    const workspaceDir = path.join(stateDir, "workspace-empty");
    await fs.mkdir(workspaceDir, { recursive: true });
    const harness = new PruneGuardHarness(
      [{ path: "memory/gone.md", hash: "hash-gone", mtime: 1, size: 1 }],
      workspaceDir,
    );

    const plan = await harness.runFullMemorySync();

    expect(plan.scanOk).toBe(true);
    expect(harness.deletedPathsFor("memory")).toEqual(["memory/gone.md"]);
  });
});
