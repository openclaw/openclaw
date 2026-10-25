import { randomUUID } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  resolveStateDir,
  type OpenClawConfig,
  type ResolvedMemorySearchConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  MEMORY_CHUNKING_VERSION,
  ensureMemoryIndexSchema,
  type MemorySource,
  type MemorySyncParams,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { MemoryIndexDatabase } from "./manager-database-context.js";
import type { MemoryIndexEntry } from "./manager-index-preparation.js";
import {
  MEMORY_INDEX_PROVENANCE_VERSION,
  resolveConfiguredScopeHash,
} from "./manager-reindex-state.js";
import { hasTargetedSessionSyncParams } from "./manager-sync-control.js";
import { MemorySyncTestHarness } from "./manager-sync-ops.test-support.js";

export const startupHarnessDatabases = new Set<MemoryIndexDatabase>();

type SourceStateRow = { path: string; hash: string; mtime: number; size: number };
type SessionUpdateBatchRunner = { processSessionUpdateBatch(): Promise<void> };

async function createStartupHarnessDatabase(
  sourceRows: SourceStateRow[],
): Promise<MemoryIndexDatabase> {
  const database = await MemoryIndexDatabase.openShadow(
    path.join(resolveStateDir(), `startup-index-${randomUUID()}.sqlite`),
    false,
  );
  startupHarnessDatabases.add(database);
  using db = new DatabaseSync(database.db.location()!);
  ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: false });
  db.exec(`
    CREATE TABLE memory_index_source_update_audit (path TEXT NOT NULL);
    CREATE TRIGGER memory_index_source_update_audit_trigger
    AFTER UPDATE ON memory_index_sources
    BEGIN
      INSERT INTO memory_index_source_update_audit (path) VALUES (NEW.path);
    END;
  `);
  const insert = db.prepare(
    `INSERT INTO memory_index_sources (path, source, hash, mtime, size) VALUES (?, 'sessions', ?, ?, ?)`,
  );
  for (const row of sourceRows) {
    insert.run(row.path, row.hash, row.mtime, row.size);
  }
  return database;
}
export class SessionStartupCatchupHarness extends MemorySyncTestHarness {
  protected readonly settings = {
    chunking: { overlap: 0, tokens: 256 },
    extraPaths: [],
    multimodal: { enabled: false, modalities: [], maxFileBytes: 0 },
    provider: "none",
    store: {
      databasePath: path.join(resolveStateDir(), "memory-index.sqlite"),
      fts: { tokenizer: "unicode61" },
      vector: { enabled: false },
    },
    sync: { sessions: { deltaBytes: 100_000, deltaMessages: 50, postCompactionForce: true } },
  } as unknown as ResolvedMemorySearchConfig;

  readonly syncCalls: MemorySyncParams[] = [];
  readonly indexedPaths: string[] = [];
  readonly indexedContents: string[] = [];
  readonly deletedSources: Array<{ path: string; source: MemorySource; expectedHash?: string }> =
    [];
  corpusListCalls = 0;
  private afterNextCorpusList: (() => Promise<void>) | null = null;
  private corpusListWork: Promise<void> = Promise.resolve();
  private pendingSyncWork: Promise<void> = Promise.resolve();

  private constructor(
    protected publishedDatabase: MemoryIndexDatabase,
    private readonly indexSessionUpdates = false,
    protected readonly cfg: OpenClawConfig = {},
  ) {
    super();
    this.sources.add("sessions");
  }

  static async create(
    sourceRows: SourceStateRow[],
    indexSessionUpdates = false,
    cfg: OpenClawConfig = {},
  ): Promise<SessionStartupCatchupHarness> {
    const harness = new SessionStartupCatchupHarness(
      await createStartupHarnessDatabase(sourceRows),
      indexSessionUpdates,
      cfg,
    );
    await harness.publishedDatabase.writeMetadata({
      model: "fts-only",
      provider: "none",
      sources: ["sessions"],
      scopeHash: resolveConfiguredScopeHash({
        workspaceDir: harness.workspaceDir,
        extraPaths: harness.settings.extraPaths,
        multimodal: harness.settings.multimodal,
      }),
      chunkTokens: harness.settings.chunking.tokens,
      chunkOverlap: harness.settings.chunking.overlap,
      chunkingVersion: MEMORY_CHUNKING_VERSION,
      ftsTokenizer: harness.settings.store.fts.tokenizer,
      provenanceVersion: MEMORY_INDEX_PROVENANCE_VERSION,
    });
    return harness;
  }

  restartForStartup(): SessionStartupCatchupHarness {
    return new SessionStartupCatchupHarness(
      this.publishedDatabase,
      this.indexSessionUpdates,
      this.cfg,
    );
  }

  getIndexedSourceState(pathname: string): SourceStateRow | undefined {
    return this.db
      .prepare(
        `SELECT path, hash, mtime, size FROM memory_index_sources WHERE path = ? AND source = 'sessions'`,
      )
      .get(pathname) as SourceStateRow | undefined;
  }

  getSourceMetadataUpdateCount(): number {
    return Number(
      this.db.prepare("SELECT COUNT(*) AS n FROM memory_index_source_update_audit").get()?.n,
    );
  }

  catchUp = () => this.runSessionStartupCatchup();
  markStartupDirtyFiles = (inspectSources = false) =>
    this.markSessionStartupCatchupDirtyFiles(inspectSources);
  runSyncForTest = (params?: MemorySyncParams) => this.runSync(params);
  runArchiveSyncForTest = () => this.syncArchiveFiles({ needsFullReindex: false });
  getDirtyArchiveFiles = () => Array.from(this.sessionsDirtyFiles);
  getPendingArchiveFiles = () => Array.from(this.sessionPendingFiles);

  addPendingSessionTarget(target: NonNullable<MemorySyncParams["sessions"]>[number]): void {
    this.sessionPendingTargets.set(
      [target.agentId ?? "", target.sessionId, target.sessionKey ?? ""].join("\0"),
      target,
    );
  }

  async processPendingSessionUpdates(): Promise<void> {
    await (this as unknown as SessionUpdateBatchRunner).processSessionUpdateBatch();
  }

  async waitForCorpusList(): Promise<void> {
    await this.corpusListWork;
    await Promise.resolve();
  }

  async waitForSessionSync(): Promise<void> {
    await this.pendingSyncWork;
    // Retry scheduling belongs to the outer operation, including overridden sync methods.
    if (this.activeManagerOperations > 0) {
      await new Promise<void>((resolve) => {
        this.managerIdleWaiters.add(resolve);
      });
    }
  }

  afterNextCorpusListForTest(callback: () => Promise<void>): void {
    this.afterNextCorpusList = callback;
  }

  isSessionsDirty = () => this.sessionsDirty;

  startTranscriptListener = () => this.ensureSessionListener();

  stopTranscriptListener(): void {
    this.sessionUnsubscribe?.();
    this.sessionUnsubscribe = null;
  }

  protected async sync(params?: MemorySyncParams): Promise<void> {
    this.syncCalls.push(params ?? {});
    this.pendingSyncWork = this.indexSessionUpdates
      ? hasTargetedSessionSyncParams(params)
        ? this.runSync(params).then(() => undefined)
        : this.syncArchiveFiles({ needsFullReindex: false }).then(() => undefined)
      : Promise.resolve();
    await this.pendingSyncWork;
  }

  protected getIndexConcurrency = () => 1;

  protected override listSessionCorpusEntries(
    targets?: Pick<MemorySyncParams, "sessions" | "archiveFiles">,
  ) {
    const work = super.listSessionCorpusEntries(targets).then(async (entries) => {
      this.corpusListCalls += 1;
      const callback = this.afterNextCorpusList;
      this.afterNextCorpusList = null;
      await callback?.();
      return entries;
    });
    this.corpusListWork = work.then(() => undefined);
    return work;
  }

  protected async indexFile(entry: MemoryIndexEntry, _source: MemorySource): Promise<void> {
    this.indexedPaths.push(entry.path);
    this.indexedContents.push(entry.content ?? "");
  }

  protected override async deleteIndexedFile(
    pathname: string,
    source: MemorySource,
    expectedHash?: string,
  ): Promise<void> {
    // This harness tests corpus selection. File-owned publication,
    // workspace locking and conditional deletion have separate integration tests.
    this.deletedSources.push({ path: pathname, source, expectedHash });
    using writer = new DatabaseSync(this.db.location()!);
    writer
      .prepare("DELETE FROM memory_index_sources WHERE path = ? AND source = ? AND hash = ?")
      .run(pathname, source, expectedHash ?? null);
  }
}
