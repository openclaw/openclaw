import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  resolveSessionTranscriptsDirForAgent,
  type OpenClawConfig,
  type ResolvedMemorySearchConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type {
  MemorySource,
  MemorySyncParams,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryManagerSyncOps } from "./manager-sync-ops.js";

type MemorySessionTranscriptUpdate = {
  agentId?: string;
  sessionFile?: string;
  sessionKey?: string;
};

const SUBSCRIBER_KEY = Symbol.for("openclaw.memoryCore.sessionTranscriptUpdateSubscriber");

class ArchiveListenerHarness extends MemoryManagerSyncOps {
  protected readonly cfg = {} as OpenClawConfig;
  protected readonly agentId = "main";
  protected readonly workspaceDir = "/tmp/openclaw-test-workspace";
  protected readonly settings = {
    chunking: { overlap: 0, tokens: 256 },
    extraPaths: [],
    multimodal: { enabled: false, modalities: [], maxFileBytes: 0 },
    provider: "none",
    store: { fts: { tokenizer: "unicode61" }, vector: { enabled: false } },
    sync: { sessions: { deltaBytes: 100_000, deltaMessages: 50, postCompactionForce: true } },
  } as unknown as ResolvedMemorySearchConfig;
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

  readonly syncCalls: MemorySyncParams[] = [];

  constructor() {
    super();
    this.sources.add("sessions");
    this.db = {
      prepare: () => ({ all: () => [], get: () => undefined, run: () => undefined }),
    } as unknown as DatabaseSync;
  }

  start(): void {
    this.ensureSessionListener();
  }

  getPendingSessionFiles(): string[] {
    return Array.from(this.sessionPendingFiles);
  }

  getDirtySessionFiles(): string[] {
    return Array.from(this.sessionsDirtyFiles);
  }

  protected computeProviderKey(): string {
    return "test";
  }

  protected resolveProviderIndexIdentities() {
    return [];
  }

  protected async sync(params?: MemorySyncParams): Promise<void> {
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

  protected async indexFile(_entry: unknown, _options: { source: MemorySource }): Promise<void> {}
}

describe("session archive live reindex listener", () => {
  let stateDir = "";
  let listener: ((update: MemorySessionTranscriptUpdate) => void) | null = null;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-archive-listener-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    (globalThis as Record<symbol, unknown>)[SUBSCRIBER_KEY] = (
      next: (update: MemorySessionTranscriptUpdate) => void,
    ) => {
      listener = next;
      return () => {
        listener = null;
      };
    };
  });

  afterEach(async () => {
    delete (globalThis as Record<symbol, unknown>)[SUBSCRIBER_KEY];
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it.each(["reset", "deleted"] as const)(
    "schedules a %s archive for live indexing when its update is emitted",
    async (reason) => {
      vi.useFakeTimers();
      const sessionsDir = resolveSessionTranscriptsDirForAgent("main");
      await fs.mkdir(sessionsDir, { recursive: true });
      const archive = path.join(sessionsDir, `thread.jsonl.${reason}.2026-06-23T10-00-00.000Z`);
      await fs.writeFile(
        archive,
        JSON.stringify({ type: "message", message: { role: "user", content: "recall fact" } }) +
          "\n",
        "utf-8",
      );

      const harness = new ArchiveListenerHarness();
      harness.start();
      expect(listener).toBeTypeOf("function");

      listener?.({ sessionFile: archive });

      expect(harness.getPendingSessionFiles()).toContain(archive);

      await vi.advanceTimersByTimeAsync(6000);

      expect(harness.getDirtySessionFiles()).toContain(archive);
      expect(harness.syncCalls.length).toBeGreaterThan(0);
    },
  );
});
