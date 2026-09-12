// Memory Core tests cover manager sync yield plugin behavior.
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  resolveSessionTranscriptsDirForAgent,
  type OpenClawConfig,
  type ResolvedMemorySearchConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type { SessionTranscriptCorpusEntry } from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import {
  ensureMemoryIndexSchema,
  requireNodeSqlite,
  type MemorySource,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { buildSessionEntryMock } = vi.hoisted(() => ({
  buildSessionEntryMock: vi.fn(),
}));
const originalSyncYieldStateDir = process.env.OPENCLAW_STATE_DIR;

function setSyncYieldStateDir(): void {
  Reflect.set(
    process.env,
    "OPENCLAW_STATE_DIR",
    path.join(os.tmpdir(), "openclaw-session-sync-yield"),
  );
}

function restoreSyncYieldStateDir(): void {
  if (originalSyncYieldStateDir === undefined) {
    Reflect.deleteProperty(process.env, "OPENCLAW_STATE_DIR");
  } else {
    Reflect.set(process.env, "OPENCLAW_STATE_DIR", originalSyncYieldStateDir);
  }
}

vi.mock("undici", async () => {
  const actual = await vi.importActual<typeof import("undici")>("undici");
  return {
    ...actual,
    Agent: vi.fn(),
    EnvHttpProxyAgent: vi.fn(),
    ProxyAgent: vi.fn(),
    fetch: vi.fn(),
    getGlobalDispatcher: vi.fn(),
    setGlobalDispatcher: vi.fn(),
  };
});

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-sessions", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/memory-core-host-engine-sessions")>();
  const basename = (filePath: string) => filePath.split(/[\\/]/).pop() ?? filePath;
  return {
    ...actual,
    buildSessionEntry: buildSessionEntryMock,
    isSessionArchiveArtifactName: (fileName: string) => /\.jsonl\.(reset|deleted)\./.test(fileName),
    isUsageCountedSessionTranscriptFileName: (fileName: string) => fileName.endsWith(".jsonl"),
    listSessionTranscriptCorpusEntriesForAgent: vi.fn(async () => []),
    parseCanonicalSessionSyncTargetFromPath: (filePath: string) => ({
      agentId: "main",
      sessionId: basename(filePath).replace(/\.jsonl$/, ""),
    }),
    sessionPathForFile: (filePath: string) => `sessions/${basename(filePath)}`,
    sessionPathForSessionIdentity: (agentId: string, sessionId: string) =>
      `sessions/${agentId}/${sessionId}`,
  };
});

vi.mock("./embeddings.js", () => ({
  resolveEmbeddingProviderAdapterTransport: (providerId: string) =>
    providerId === "local" ? "local" : "remote",
  resolveEmbeddingProviderIndexIdentity: () => undefined,
  createEmbeddingProvider: vi.fn(),
}));

import { MemoryIndexDatabase } from "./manager-database-context.js";
import { MemoryManagerSyncOps } from "./manager-sync-ops.js";

type MemoryIndexEntry = {
  path: string;
  absPath: string;
  mtimeMs: number;
  size: number;
  hash: string;
  content?: string;
};

function createDb(): DatabaseSync {
  const { DatabaseSync: NodeDatabaseSync } = requireNodeSqlite();
  const db = new NodeDatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    cacheEnabled: true,
    ftsEnabled: false,
    ftsTokenizer: "unicode61",
  });
  return db;
}

class SessionSyncYieldHarness extends MemoryManagerSyncOps {
  protected readonly createProvider = (): never => {
    throw new Error("Sync yield harness does not acquire embedding providers");
  };
  protected releaseProvider(): never {
    throw new Error("Sync yield harness does not own embedding providers");
  }
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
  protected readonly cache = { enabled: false };
  protected providerUnavailableReason?: string;
  protected providerLifecycle = { mode: "active" as const, providerId: "test" };
  protected publishedDatabase: MemoryIndexDatabase;

  readonly indexedPaths: string[] = [];
  private corpusFiles: string[] = [];

  constructor(
    db: DatabaseSync,
    private readonly onIndexFile: (count: number) => void,
    private readonly indexConcurrency: number,
  ) {
    super();
    this.publishedDatabase = new MemoryIndexDatabase(db);
  }

  async syncTargetArchiveFiles(files: string[]): Promise<void> {
    this.corpusFiles = files;
    await this.syncArchiveFiles({
      needsFullReindex: false,
      targetArchiveFiles: files,
    });
  }

  protected override async listSessionCorpusEntries(): Promise<SessionTranscriptCorpusEntry[]> {
    return this.corpusFiles.map((sessionFile, index) => ({
      agentId: this.agentId,
      artifactKind: "archive-artifact",
      sessionFile,
      sessionId: `session-${index}`,
    }));
  }

  protected computeProviderKey(): string {
    return "test";
  }

  protected resolveProviderIndexIdentities() {
    return [];
  }

  protected async sync(): Promise<void> {}

  protected async withTimeout<T>(
    promise: Promise<T>,
    _timeoutMs: number,
    _message: string,
  ): Promise<T> {
    return await promise;
  }

  protected getIndexConcurrency(): number {
    return this.indexConcurrency;
  }

  protected async pruneEmbeddingCacheIfNeeded(): Promise<void> {}

  protected resetProviderInitializationForRetry(): void {}

  protected assertRequiredProviderAvailable(): void {}

  protected async indexFile(
    entry: MemoryIndexEntry,
    _options: { source: MemorySource; content?: string },
  ): Promise<void> {
    this.indexedPaths.push(entry.path);
    this.onIndexFile(this.indexedPaths.length);
  }
}

describe("session sync responsiveness", () => {
  beforeEach(() => {
    setSyncYieldStateDir();
    buildSessionEntryMock.mockImplementation(async (absPath: string) => {
      const name = path.basename(absPath);
      return {
        path: `sessions/${name}`,
        absPath,
        mtimeMs: 1,
        size: 1,
        hash: `hash-${name}`,
        content: `user message for ${name}`,
      };
    });
  });

  afterEach(() => {
    restoreSyncYieldStateDir();
    vi.clearAllMocks();
  });

  it.each([
    { concurrency: 1, fileCount: 4 },
    { concurrency: 4, fileCount: 40 },
  ])(
    "serves queued work during slow session indexing with $concurrency workers",
    async ({ concurrency, fileCount }) => {
      const sessionsDir = resolveSessionTranscriptsDirForAgent("main");
      const files = Array.from({ length: fileCount }, (_value, index) =>
        path.join(sessionsDir, `session-${index}.jsonl.deleted.2026-07-11T00-00-00.000Z`),
      );
      let immediateRan = false;
      const immediate = new Promise<void>((resolve) => {
        setImmediate(() => {
          immediateRan = true;
          resolve();
        });
      });
      const observedBeforeNextWave: boolean[] = [];
      const db = createDb();
      let elapsedMs = 0;
      const clock = vi.spyOn(performance, "now").mockImplementation(() => elapsedMs);
      const harness = new SessionSyncYieldHarness(
        db,
        (count) => {
          // Model expensive synchronous indexing without sleeping or a timing-sensitive assertion.
          elapsedMs += 20;
          if (count === concurrency + 1) {
            observedBeforeNextWave.push(immediateRan);
          }
        },
        concurrency,
      );

      try {
        await harness.syncTargetArchiveFiles(files);
        expect(harness.indexedPaths).toEqual(
          files.map((file) => `sessions/${path.basename(file)}`),
        );
        expect(observedBeforeNextWave).toEqual([true]);
        await immediate;
      } finally {
        clock.mockRestore();
        await immediate;
        db.close();
      }
    },
  );
});
