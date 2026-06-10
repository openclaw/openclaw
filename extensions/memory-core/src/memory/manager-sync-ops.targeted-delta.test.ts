// Memory Core tests cover session delta sync targeting: event-driven delta
// syncs pass the dirty set as explicit targets (skipping the sessions-dir
// enumeration), and fall back to a full enumeration at most once per
// reconcile window so out-of-band deletions still get pruned.
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

type RecordedSync = { reason?: string; force?: boolean; sessionFiles?: string[] };

class TargetedDeltaHarness extends MemoryManagerSyncOps {
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

  readonly syncCalls: RecordedSync[] = [];

  constructor(protected readonly workspaceDir = "/tmp/openclaw-test-workspace") {
    super();
    this.sources.add("sessions");
    this.db = {
      prepare: () => ({ all: () => [], get: () => undefined, run: () => undefined }),
    } as unknown as DatabaseSync;
  }

  async runDeltaBatch(pendingFiles: string[]): Promise<void> {
    for (const file of pendingFiles) {
      this.sessionPendingFiles.add(file);
    }
    await (
      this as unknown as { processSessionDeltaBatch: () => Promise<void> }
    ).processSessionDeltaBatch();
  }

  addDirtyFile(sessionFile: string): void {
    this.sessionsDirtyFiles.add(sessionFile);
  }

  setLastReconcileAt(ms: number): void {
    (this as unknown as { lastSessionPruneReconcileAt: number }).lastSessionPruneReconcileAt = ms;
  }

  lastReconcileAt(): number {
    return (this as unknown as { lastSessionPruneReconcileAt: number }).lastSessionPruneReconcileAt;
  }

  async runFullSessionSync(): Promise<void> {
    await (
      this as unknown as { syncSessionFiles: (p: unknown) => Promise<unknown> }
    ).syncSessionFiles({ needsFullReindex: true });
  }

  protected computeProviderKey(): string {
    return "test";
  }

  protected async sync(params?: RecordedSync): Promise<void> {
    this.syncCalls.push(params ?? {});
  }

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

// Archive artifacts route through the direct mark-dirty branch of the delta
// batch, so tests need no transcript fixtures or delta accounting.
function archiveSessionFile(name: string): string {
  return path.join(
    resolveSessionTranscriptsDirForAgent("main"),
    `${name}.jsonl.reset.2026-01-01T00-00-00.000Z`,
  );
}

describe("session delta sync targeting", () => {
  let stateDir = "";

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-targeted-delta-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("passes the dirty set as sync targets inside the reconcile window", async () => {
    const harness = new TargetedDeltaHarness();
    harness.setLastReconcileAt(Date.now());
    const archived = archiveSessionFile("thread-a");

    await harness.runDeltaBatch([archived]);

    expect(harness.syncCalls).toEqual([{ reason: "session-delta", sessionFiles: [archived] }]);
  });

  it("includes leftover dirty files from earlier syncs in the targets", async () => {
    const harness = new TargetedDeltaHarness();
    harness.setLastReconcileAt(Date.now());
    const leftover = archiveSessionFile("thread-leftover");
    const fresh = archiveSessionFile("thread-fresh");
    harness.addDirtyFile(leftover);

    await harness.runDeltaBatch([fresh]);

    expect(harness.syncCalls).toHaveLength(1);
    expect(harness.syncCalls[0]?.reason).toBe("session-delta");
    expect(new Set(harness.syncCalls[0]?.sessionFiles)).toEqual(new Set([leftover, fresh]));
  });

  it("falls back to a full enumeration once the reconcile window elapses", async () => {
    // lastSessionPruneReconcileAt starts at 0, so the first active delta sync
    // reconciles with a full enumeration unless a prior prune already ran.
    const harness = new TargetedDeltaHarness();

    await harness.runDeltaBatch([archiveSessionFile("thread-b")]);

    expect(harness.syncCalls).toEqual([{ reason: "session-delta" }]);
  });

  it("advances the reconcile timestamp after an authoritative prune", async () => {
    await fs.mkdir(resolveSessionTranscriptsDirForAgent("main"), { recursive: true });
    const harness = new TargetedDeltaHarness();

    await harness.runFullSessionSync();

    expect(harness.lastReconcileAt()).toBeGreaterThan(0);
  });

  it("does not advance the reconcile timestamp when the scan fails", async () => {
    await fs.mkdir(resolveSessionTranscriptsDirForAgent("main"), { recursive: true });
    const harness = new TargetedDeltaHarness();
    vi.spyOn(fs, "readdir").mockRejectedValueOnce(
      Object.assign(new Error("nfs blip"), { code: "EIO" }),
    );

    await harness.runFullSessionSync();

    expect(harness.lastReconcileAt()).toBe(0);
  });
});
