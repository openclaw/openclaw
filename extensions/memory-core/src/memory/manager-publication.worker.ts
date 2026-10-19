import type { DatabaseSync } from "node:sqlite";
import type {
  EngineConnection,
  SearchSchema,
} from "openclaw/plugin-sdk/database-engine-worker-runtime";
import { admitStoreSearch } from "openclaw/plugin-sdk/database-engine-worker-runtime";
import {
  ensureMemoryIndexSchema,
  loadSqliteVecExtensionFromPath,
  MEMORY_INDEX_FTS_TABLE,
  MEMORY_INDEX_PATHS_FTS_TABLE,
  MEMORY_INDEX_VECTOR_TABLE,
  stageMemoryIndexSchemaExtension,
} from "openclaw/plugin-sdk/memory-core-host-engine-schema";
import {
  isPostgresSqlConnection,
  closeMemorySqliteWalMaintenance,
  configureMemorySqliteWalMaintenance,
  loadSqliteVecExtension,
  stopMemorySqliteWalMaintenance,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { readOpenClawAgentDatabaseIdentity } from "openclaw/plugin-sdk/sqlite-runtime";
import {
  bindSqliteWorkerDatabase,
  admitSqliteSchema,
  getAdmittedSqliteSchemaFacts,
  openNodeSqliteDatabase,
  resolveExistingSqliteFileUri,
  requestSqliteWorkerOperationAdmission,
  readSqliteDatabasePendingScopedWriteToken,
  readSqliteDatabaseScopedWriteToken,
  runSqliteImmediateTransactionSync,
  runSqliteSingleStatementSync,
  setSqliteBusyTimeout,
  stageOpenClawAgentDatabaseSchemaExtension,
  supportsNodeSqliteExtensionLoading,
  tableExists,
  withSqliteDatabaseWriteScope,
  type SqliteWorkerBackend,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { advanceMemoryIndexRevision } from "../memory-index-revision.worker.js";
import { hasMemorySessionTombstone } from "../memory-session-tombstones.js";
import { publishMemoryDatabaseTables } from "./manager-db-kernel.js";
import {
  clearMemoryEmbeddingCacheIdentities,
  countMemoryEmbeddingCache,
  pruneMemoryEmbeddingCache,
  upsertMemoryEmbeddingCache,
} from "./manager-embedding-cache.js";
import {
  upgradeMemoryIndexProviderKey,
  writeMemoryIndexMetadata,
} from "./manager-index-metadata.js";
import { readMemoryIndex } from "./manager-index-read.js";
import { bindPostgresMemoryPublication } from "./manager-publication-postgres.js";
import type {
  MemoryEmbeddingCacheEntry,
  MemoryEmbeddingCacheHeader,
  MemoryPublicationConnection,
  MemoryPublicationFragment,
  MemoryPublicationOperations,
  MemoryPublicationResult,
} from "./manager-publication-task.js";
import {
  MEMORY_EMBEDDING_CACHE_WRITE_SCOPE,
  MEMORY_INDEX_WRITE_SCOPE,
} from "./manager-publication-task.js";
import { readMemoryDatabaseFacts } from "./manager-retrieval-read.js";
import { admitMemoryVectorIndex } from "./manager-search-knn.js";
import { memoryVectorSearchSchema } from "./manager-search-schema.js";
import {
  assertMemoryShadowIdentity,
  readMemoryShadowIdentity,
  readMemoryConnectionPragmas,
  type MemoryShadowConnection,
  type MemoryShadowFailure,
} from "./manager-shadow-task.js";
import {
  MemorySourceIndexKernel,
  type MemorySourceIndexHeader,
  type MemorySourceIndexRow,
} from "./manager-source-index-kernel.js";
import { refreshMemorySessionSourceState } from "./manager-source-state.js";

type PublicationConnection =
  | MemoryShadowConnection
  | {
      kind: "agent";
      pragmas: MemoryShadowConnection["pragmas"];
    };

// The agent owner configures these once; temporary transaction settings restore them.
const agentConnectionPragmas = new WeakMap<DatabaseSync, MemoryShadowConnection["pragmas"]>();
const loadedExtensions = new WeakMap<DatabaseSync, string>();
const embeddingCacheSizes = new WeakMap<DatabaseSync, { size: number; token?: string }>();

function failure(error: unknown): MemoryShadowFailure {
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
    ...(error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? { code: error.code }
      : {}),
    ...(error &&
    typeof error === "object" &&
    "errcode" in error &&
    typeof error.errcode === "number"
      ? { errcode: error.errcode }
      : {}),
  };
}

export function createSqliteWorkerBackend(
  input: { allowExtension: boolean },
  context: { databasePath: string },
): Promise<SqliteWorkerBackend<MemoryPublicationOperations>> {
  return openShadowBackend(context.databasePath, input.allowExtension);
}

export function openExistingSqliteWorkerBackend(
  input: MemoryShadowConnection,
  context: { databasePath: string },
): Promise<SqliteWorkerBackend<MemoryPublicationOperations>> {
  return openShadowBackend(context.databasePath, true, input);
}

async function openShadowBackend(
  databasePath: string,
  allowExtension: boolean,
  existing?: MemoryShadowConnection,
): Promise<SqliteWorkerBackend<MemoryPublicationOperations>> {
  const db = openNodeSqliteDatabase(
    existing ? resolveExistingSqliteFileUri(databasePath) : databasePath,
    {
      allowExtension: allowExtension && !process.permission && supportsNodeSqliteExtensionLoading(),
    },
  );
  const close = async () => {
    await stopMemorySqliteWalMaintenance(db);
    try {
      closeMemorySqliteWalMaintenance(db);
    } finally {
      if (db.isOpen) {
        db.close();
      }
    }
  };
  try {
    configureMemorySqliteWalMaintenance(db, { busyTimeoutMs: 5_000, databasePath });
    const connection = existing ?? {
      fileIdentity: readMemoryShadowIdentity(databasePath),
      pragmas: readMemoryConnectionPragmas(db, "Invalid memory publication connection policy"),
    };
    return {
      ...createPublicationBackend(connection, databasePath, db, (stage) =>
        requestSqliteWorkerOperationAdmission({ stage, facts: undefined }),
      ),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Agent publication borrows its executor connection; only private shadows open their own. */
export function bindSqliteWorkerBackend(
  input: MemoryPublicationConnection,
  context: {
    databasePath: string;
    database: EngineConnection;
    admitSearchExtensions?: (definitions: Readonly<Record<string, SearchSchema>>) => void;
    admit(stage: "transaction" | "commit"): void;
  },
) {
  if (isPostgresSqlConnection(context.database)) {
    return bindPostgresMemoryPublication(context, "kind" in input ? input.stageId : undefined);
  }
  const db = context.database;
  let pragmas = agentConnectionPragmas.get(db);
  if ("kind" in input && !pragmas) {
    pragmas = readMemoryConnectionPragmas(db, "Invalid memory publication connection policy");
    agentConnectionPragmas.set(db, pragmas);
  }
  const connection: PublicationConnection =
    "kind" in input
      ? {
          kind: "agent",
          pragmas: pragmas!,
        }
      : input;
  return createPublicationBackend(connection, context.databasePath, db, (stage) =>
    context.admit(stage),
  );
}

function createPublicationBackend(
  input: PublicationConnection,
  databasePath: string,
  db: DatabaseSync,
  admit: (stage: "transaction" | "commit") => void,
) {
  const vectorIndex = admitMemoryVectorIndex(db);
  // Agent handles are admitted by the database owner; private shadows are checked once on open.
  if (!("kind" in input)) {
    assertMemoryShadowIdentity(databasePath, input.fileIdentity);
  }
  // Each agent run binds its own backend; shadow runs use the private writer queue.
  // Large sources stay in worker memory without per-fragment SQLite I/O.
  let staged:
    | ({
        fragments: MemoryPublicationFragment[];
      } & (
        | { kind: "source"; header: MemorySourceIndexHeader }
        | { kind: "cache"; header: MemoryEmbeddingCacheHeader }
      ))
    | undefined;
  const loadExtension = (extensionPath: string | undefined) => {
    if (extensionPath && extensionPath !== loadedExtensions.get(db)) {
      loadSqliteVecExtensionFromPath(db, extensionPath);
      loadedExtensions.set(db, extensionPath);
    }
  };
  const discard = () => {
    staged = undefined;
  };
  const finish = <T>(outcome: MemoryPublicationResult<T>): MemoryPublicationResult<T> => {
    if (outcome.ok) {
      discard();
    }
    return outcome;
  };
  const transact = <T>(
    run: (hooks: { onBegin: () => void; withCommit: (commit: () => void) => void }) => T,
  ): MemoryPublicationResult<T> => {
    let entered = false;
    let committed = false;
    let writeToken: string | undefined;
    let restoredBusyTimeout = false;
    const restoreBusyTimeout = () => {
      if (!restoredBusyTimeout) {
        setSqliteBusyTimeout(db, input.pragmas.busy_timeout);
        restoredBusyTimeout = true;
      }
    };
    try {
      // Failed BEGIN is returned to the preparing host without sleeping here.
      // It revalidates memory-file input before every retry, as before.
      setSqliteBusyTimeout(db, 0);
      const value = run({
        onBegin: () => {
          entered = true;
          restoreBusyTimeout();
          admit("transaction");
        },
        withCommit: (commit) => {
          admit("commit");
          writeToken = readSqliteDatabasePendingScopedWriteToken(db, MEMORY_INDEX_WRITE_SCOPE);
          commit();
          committed = true;
        },
      });
      return { ok: true, value, writeToken };
    } catch (error) {
      return { ok: false, error: failure(error), entered, committed };
    } finally {
      if (db.isOpen) {
        restoreBusyTimeout();
      }
    }
  };
  const write = <T>(
    run: () => T,
    scopes = [MEMORY_INDEX_WRITE_SCOPE],
  ): MemoryPublicationResult<T> =>
    transact((hooks) =>
      runSqliteImmediateTransactionSync(
        db,
        () => {
          hooks.onBegin();
          // Index writes do not change session facts. DDL still invalidates all scopes.
          return withSqliteDatabaseWriteScope(db, scopes, run);
        },
        { withCommit: hooks.withCommit },
      ),
    );
  const writeSingleStatement = <T>(statement: () => T): MemoryPublicationResult<T> => {
    let statementStarted = false;
    let committed = false;
    try {
      admit("transaction");
      // Autocommit makes the statement the effect boundary.
      admit("commit");
      setSqliteBusyTimeout(db, 0);
      statementStarted = true;
      const value = withSqliteDatabaseWriteScope(db, [MEMORY_INDEX_WRITE_SCOPE], () =>
        runSqliteSingleStatementSync(db, statement),
      );
      committed = true;
      const writeToken = readSqliteDatabaseScopedWriteToken(db, MEMORY_INDEX_WRITE_SCOPE);
      return { ok: true, value, writeToken };
    } catch (error) {
      const detail = failure(error);
      // Only a native lock refusal proves that the autocommit statement did not enter.
      const lockRefused =
        statementStarted &&
        !committed &&
        detail.errcode !== undefined &&
        [5, 6].includes(detail.errcode & 0xff);
      return { ok: false, error: detail, entered: !lockRefused, committed };
    } finally {
      if (statementStarted && db.isOpen) {
        setSqliteBusyTimeout(db, input.pragmas.busy_timeout);
      }
    }
  };
  const withFacts = <T>(
    result: MemoryPublicationResult<T>,
    includeSearchSchema = false,
  ): MemoryPublicationResult<T> => {
    if (!result.ok) {
      return result;
    }
    const facts = readMemoryDatabaseFacts(db);
    // DDL receipts carry the admitted SQL verbatim, including sqlite-vec's exact declaration.
    const schema = includeSearchSchema && getAdmittedSqliteSchemaFacts(db)!.tableSql;
    return {
      ...result,
      facts,
      ...(schema
        ? {
            searchSchema: {
              fts: schema.get(MEMORY_INDEX_FTS_TABLE) ?? null,
              paths: schema.get(MEMORY_INDEX_PATHS_FTS_TABLE) ?? null,
              vector: schema.get(MEMORY_INDEX_VECTOR_TABLE) ?? null,
            },
          }
        : {}),
    };
  };
  const cacheSize = () => {
    const token = readSqliteDatabaseScopedWriteToken(db, MEMORY_EMBEDDING_CACHE_WRITE_SCOPE);
    let retained = embeddingCacheSizes.get(db);
    if (!retained || retained.token !== token) {
      retained = { size: countMemoryEmbeddingCache(db), token };
      embeddingCacheSizes.set(db, retained);
    }
    return retained.size;
  };
  const writeCache = (run: (size: number) => number): MemoryPublicationResult<boolean> => {
    const size = cacheSize();
    const result = write(() => run(size), [MEMORY_EMBEDDING_CACHE_WRITE_SCOPE]);
    if (!result.ok) {
      return result;
    }
    embeddingCacheSizes.set(db, {
      size: result.value,
      token: readSqliteDatabaseScopedWriteToken(db, MEMORY_EMBEDDING_CACHE_WRITE_SCOPE),
    });
    return { ...result, value: true };
  };
  return bindSqliteWorkerDatabase<MemoryPublicationOperations>(db, {
    async prepare(command) {
      if (command.type !== "vector.prepare") {
        return;
      }
      const extensionPath = command.input.state.extensionPath;
      const loadedPath = loadedExtensions.get(db);
      if (loadedPath && (!extensionPath || extensionPath === loadedPath)) {
        return;
      }
      // Module resolution can yield; the executor awaits preparation before
      // entering its synchronous operation and transaction admission.
      const loaded = await loadSqliteVecExtension({ db, extensionPath });
      if (!loaded.ok || !loaded.extensionPath) {
        throw new Error(loaded.error ?? "unknown sqlite-vec load error");
      }
      loadedExtensions.set(db, loaded.extensionPath);
    },
    execute(command) {
      if (command.type === "database.reset") {
        throw new Error("Worker memory reset requires PostgreSQL");
      }
      if (
        command.type === "database.stage.start" ||
        command.type === "database.stage.publish" ||
        command.type === "database.stage.discard"
      ) {
        throw new Error("Connection-local memory staging requires PostgreSQL");
      }
      if (command.type === "connection.inspect") {
        return "kind" in input
          ? {
              fileIdentity: readMemoryShadowIdentity(databasePath),
              pragmas: readMemoryConnectionPragmas(
                db,
                "Invalid memory publication connection policy",
              ),
            }
          : input;
      }
      if (
        command.type === "index.facts" ||
        command.type === "source.state" ||
        command.type === "source.hash" ||
        command.type === "source.chunks" ||
        command.type === "cache.read" ||
        command.type === "session.current"
      ) {
        return readMemoryIndex(db, command).value;
      }
      if (command.type === "schema.admit") {
        // Storage/STRICT migration must disable foreign keys before BEGIN.
        db.exec("PRAGMA foreign_keys = OFF");
        try {
          const result = write(() => {
            stageOpenClawAgentDatabaseSchemaExtension(db);
            return ensureMemoryIndexSchema({ ...command.input, db });
          });
          if (result.ok) {
            admitSqliteSchema(db);
          }
          const published = withFacts(result, true);
          return published.ok && "kind" in input
            ? {
                ...published,
                value: {
                  ...published.value,
                  admission: {
                    hasIndex: true,
                    ftsAvailable: published.value.ftsAvailable,
                    schemaVersion: getAdmittedSqliteSchemaFacts(db)?.userVersion,
                    identity: readOpenClawAgentDatabaseIdentity({ db }),
                    facts: published.facts,
                  },
                },
              }
            : published;
        } finally {
          if (db.isOpen) {
            db.exec(`PRAGMA foreign_keys = ${input.pragmas.foreign_keys}`);
          }
        }
      }
      if (command.type === "index.upgradeProviderKey") {
        return withFacts(
          write(
            () => upgradeMemoryIndexProviderKey(db, command.input),
            [MEMORY_INDEX_WRITE_SCOPE, MEMORY_EMBEDDING_CACHE_WRITE_SCOPE],
          ),
        );
      }
      if (command.type === "index.writeMetadata") {
        return withFacts(writeSingleStatement(() => writeMemoryIndexMetadata(db, command.input)));
      }
      if (command.type === "source.refresh") {
        return withFacts(
          write(() => {
            const changed = refreshMemorySessionSourceState(db, command.input);
            if (changed) {
              advanceMemoryIndexRevision(db);
            }
            return changed;
          }),
        );
      }
      if (command.type === "stage.start" || command.type === "cache.stage.start") {
        staged =
          command.type === "stage.start"
            ? { ...command.input, kind: "source", fragments: [] }
            : { ...command.input, kind: "cache", fragments: [] };
        return undefined;
      }
      if (command.type === "stage.discard") {
        discard();
        return undefined;
      }
      if (command.type === "stage.append") {
        if (!staged) {
          throw new Error("Memory publication input was not started");
        }
        staged.fragments.push(...command.input.fragments);
        return undefined;
      }
      if (command.type === "cache.prune") {
        if (cacheSize() <= command.input.maxEntries) {
          return { ok: true, value: false };
        }
        return writeCache((size) => pruneMemoryEmbeddingCache(db, size, command.input.maxEntries));
      }
      if (command.type === "cache.clear") {
        return writeCache(
          (size) => size - clearMemoryEmbeddingCacheIdentities(db, command.input.identities),
        );
      }
      if (command.type === "cache.write" || command.type === "cache.write.inline") {
        let header: MemoryEmbeddingCacheHeader;
        let readEntries: () => Iterable<MemoryEmbeddingCacheEntry>;
        if (command.type === "cache.write.inline") {
          header = command.input.header;
          const entries = command.input.entries;
          readEntries = () => entries;
        } else {
          if (staged?.kind !== "cache") {
            throw new Error("Memory cache input was not started");
          }
          header = staged.header;
          const fragments = staged.fragments;
          readEntries = () => readPublicationRows<MemoryEmbeddingCacheEntry>(fragments);
        }
        const outcome = writeCache((size) => {
          const eligible = new Map<string, boolean>();
          function* entries() {
            for (const entry of readEntries()) {
              if (entry.sessionId) {
                let current = eligible.get(entry.sessionId);
                if (current === undefined) {
                  current = !hasMemorySessionTombstone(db, header.agentId, entry.sessionId);
                  eligible.set(entry.sessionId, current);
                }
                if (!current) {
                  continue;
                }
              }
              yield entry;
            }
          }
          return upsertMemoryEmbeddingCache({ ...header, db, cacheSize: size, entries });
        });
        return command.type === "cache.write" ? finish(outcome) : outcome;
      }
      if (command.type === "vector.prepare") {
        const loadedPath = loadedExtensions.get(db);
        if (!loadedPath) {
          throw new Error("Memory vector extension was not prepared");
        }
        if (!tableExists(db, "chunks_vec")) {
          return {
            ok: true,
            value: { extensionPath: loadedPath, retiredLegacy: false },
          };
        }
        return withFacts(
          write(() => {
            stageMemoryIndexSchemaExtension(db);
            stageOpenClawAgentDatabaseSchemaExtension(db);
            db.exec("DROP TABLE IF EXISTS chunks_vec");
            return { extensionPath: loadedPath, retiredLegacy: true };
          }),
        );
      }
      if (command.type === "vector.ensure") {
        const { dimensions } = command.input;
        if (!Number.isSafeInteger(dimensions) || dimensions <= 0) {
          throw new Error("Memory vector dimensions must be a positive integer");
        }
        const { meta, hasIndexedChunks, hasVectorTable } = readMemoryDatabaseFacts(db);
        const currentDimensions = meta ? meta.vectorDims : command.input.currentDimensions;
        if (currentDimensions === dimensions && hasVectorTable) {
          loadExtension(command.input.state.extensionPath);
          admitStoreSearch(db, memoryVectorSearchSchema(dimensions), {
            extension: "memory.vector",
          });
          return { ok: true, value: undefined };
        }
        loadExtension(command.input.state.extensionPath);
        return withFacts(
          write(() => {
            stageMemoryIndexSchemaExtension(db);
            stageOpenClawAgentDatabaseSchemaExtension(db);
            vectorIndex.capability.drop(vectorIndex.index);
            vectorIndex.capability.create(vectorIndex.index, dimensions);
            admitStoreSearch(db, memoryVectorSearchSchema(dimensions), {
              extension: "memory.vector",
            });
            if (meta && !meta.vectorDims && !hasIndexedChunks) {
              writeMemoryIndexMetadata(db, { ...meta, vectorDims: dimensions });
            }
          }),
          true,
        );
      }
      loadExtension(command.input.state.extensionPath);
      if (command.type === "database.publish") {
        const publication = command.input;
        return withFacts(
          transact((hooks) => {
            assertMemoryShadowIdentity(publication.sourcePath, publication.sourceIdentity);
            publishMemoryDatabaseTables({
              ...publication,
              targetDb: db,
              onBegin: () => {
                hooks.onBegin();
                stageOpenClawAgentDatabaseSchemaExtension(db);
                assertMemoryShadowIdentity(publication.sourcePath, publication.sourceIdentity);
              },
              withCommit: hooks.withCommit,
            });
          }),
        );
      }
      if (command.type === "source.delete") {
        return withFacts(
          write(() => {
            const changed = new MemorySourceIndexKernel(db, command.input.state).deleteIfCurrent(
              command.input,
            );
            if (changed) {
              advanceMemoryIndexRevision(db);
            }
            return changed;
          }),
        );
      }
      if (command.type === "source.replace.group") {
        const outcome = write(() => {
          const kernel = new MemorySourceIndexKernel(db, command.input.state);
          const inputs = command.input.sources;
          function* sources() {
            for (const { header, fragments } of inputs) {
              if (
                header.source === "sessions" &&
                hasMemorySessionTombstone(db, header.agentId, header.sessionId)
              ) {
                throw new Error(
                  "A session was forgotten while memory indexing was running; retry the memory index.",
                );
              }
              yield { header, rows: readPublicationRows<MemorySourceIndexRow>(fragments) };
            }
          }
          kernel.replaceGroup(sources());
          advanceMemoryIndexRevision(db);
          return true;
        });
        return outcome.ok
          ? { ...outcome, facts: readMemoryDatabaseFacts(db, command.input.state.hasVectorTable) }
          : outcome;
      }
      let header: MemorySourceIndexHeader;
      let rows: Iterable<MemorySourceIndexRow>;
      if (command.type === "source.replace.inline") {
        header = command.input.header;
        rows = readPublicationRows<MemorySourceIndexRow>(command.input.fragments);
      } else {
        if (staged?.kind !== "source") {
          throw new Error("Memory publication input was not started");
        }
        header = staged.header;
        rows = readPublicationRows<MemorySourceIndexRow>(staged.fragments);
      }
      let facts: ReturnType<typeof readMemoryDatabaseFacts> | undefined;
      const outcome = write(() => {
        if (
          header.source === "sessions" &&
          hasMemorySessionTombstone(db, header.agentId, header.sessionId)
        ) {
          throw new Error(
            "A session was forgotten while memory indexing was running; retry the memory index.",
          );
        }
        new MemorySourceIndexKernel(db, command.input.state).replaceRows(header, rows);
        advanceMemoryIndexRevision(db);
        facts = readMemoryDatabaseFacts(db, command.input.state.hasVectorTable);
        return true;
      });
      const published = outcome.ok ? { ...outcome, facts } : outcome;
      return command.type === "source.replace.inline" ? published : finish(published);
    },
    close() {
      discard();
    },
  });
}

function* readPublicationRows<Row extends MemorySourceIndexRow | MemoryEmbeddingCacheEntry>(
  fragments: Iterable<MemoryPublicationFragment>,
): Generator<Row> {
  // SAFETY: Only the paired source/cache producer writes these sealed records.
  const parse = (parts: string[]) => JSON.parse(parts.join("")) as Row;
  let parts: string[] = [];
  for (const fragment of fragments) {
    parts.push(fragment.json);
    if (fragment.last) {
      yield parse(parts);
      parts = [];
    }
  }
  if (parts.length) {
    yield parse(parts);
  }
}
