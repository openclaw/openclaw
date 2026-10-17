import { randomUUID } from "node:crypto";
import type {
  EngineConnection,
  SearchSchema,
} from "openclaw/plugin-sdk/database-engine-worker-runtime";
import {
  isPostgresSqlConnection,
  MEMORY_INDEX_DERIVED_TABLES,
  MEMORY_INDEX_STATE_TABLE,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { readOpenClawAgentDatabaseIdentity } from "openclaw/plugin-sdk/sqlite-runtime";
import {
  bindSqliteWorkerDatabase,
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  tableExists,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { hasMemorySessionTombstone } from "../memory-session-tombstones.js";
import { MemoryIndexRevisionConflictError } from "./manager-db-kernel.js";
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
import type {
  MemoryEmbeddingCacheEntry,
  MemoryPublicationFragment,
  MemoryPublicationOperations,
  MemoryPublicationResult,
} from "./manager-publication-task.js";
import type { MemoryIndexMeta } from "./manager-reindex-state.js";
import { readMemoryDatabaseFacts, type MemoryDatabaseFacts } from "./manager-retrieval-read.js";
import { memoryTextSearchSchema, memoryVectorSearchSchema } from "./manager-search-schema.js";
import {
  MemorySourceIndexKernel,
  type MemorySourceIndexHeader,
  type MemorySourceIndexRow,
} from "./manager-source-index-kernel.js";
import { refreshMemorySessionSourceState } from "./manager-source-state.js";
import { markMemoryVectorIndexClean } from "./manager-vector-rebuild-state.js";

type StagingState = {
  spool: string;
  created: boolean;
  header:
    | MemorySourceIndexHeader
    | MemoryPublicationOperations["cache.stage.start"]["input"]["header"]
    | undefined;
  stageKind: "source" | "cache" | undefined;
  rebuilding: MemoryDatabaseFacts | undefined;
  metadata: MemoryIndexMeta | undefined;
};
const reindexStages = new WeakMap<EngineConnection, Map<string, StagingState>>();

/** A connection-local spool bounds transfer memory and disappears with its owning worker. */
export function bindPostgresMemoryPublication(
  context: {
    database: EngineConnection;
    admit(stage: "transaction" | "commit"): void;
    admitSearchExtensions?: (definitions: Readonly<Record<string, SearchSchema>>) => void;
  },
  stageId?: string,
) {
  const db = context.database;
  if (!isPostgresSqlConnection(db) || !context.admitSearchExtensions) {
    throw new Error("PostgreSQL memory publication requires agent-owned search admission");
  }
  const admitSearch = context.admitSearchExtensions;
  let spool = `memory_stage_${randomUUID().replaceAll("-", "")}`;
  let created = false;
  let header:
    | MemorySourceIndexHeader
    | MemoryPublicationOperations["cache.stage.start"]["input"]["header"]
    | undefined;
  let stageKind: "source" | "cache" | undefined;
  let rebuilding: MemoryDatabaseFacts | undefined;
  let metadata: MemoryIndexMeta | undefined;
  let bindingStageId = stageId;
  let stages = reindexStages.get(db);
  if (!stages) {
    stages = new Map();
    reindexStages.set(db, stages);
  }
  let retainState = stageId !== undefined && stages.has(stageId);
  const restore = (retained: StagingState) => {
    ({ spool, created, header, stageKind, rebuilding, metadata } = retained);
  };
  if (stageId && stages.has(stageId)) {
    restore(stages.get(stageId)!);
  }
  const write = <T>(run: () => T): MemoryPublicationResult<T> => {
    let entered = false;
    let committed = false;
    const previousFacts = rebuilding && { ...rebuilding };
    const previousMetadata = metadata;
    const previousCreated = created;
    try {
      const value = db.runTransaction(
        () => {
          context.admit("transaction");
          entered = true;
          return run();
        },
        {
          withCommit: (commit) => {
            context.admit("commit");
            commit();
            committed = true;
          },
        },
      );
      return { ok: true, value, facts: rebuilding ?? readMemoryDatabaseFacts(db) };
    } catch (error) {
      if (!committed) {
        rebuilding = previousFacts;
        metadata = previousMetadata;
        created = previousCreated;
      }
      return {
        ok: false,
        entered,
        committed,
        error: {
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  };
  const ensureSpool = () => {
    if (created) {
      return;
    }
    db.exec(
      `CREATE TEMP TABLE ${spool} (ordinal BIGINT GENERATED ALWAYS AS IDENTITY, lane TEXT NOT NULL, header TEXT, json TEXT, last INTEGER, PRIMARY KEY (lane, ordinal))`,
    );
    created = true;
  };
  const append = (
    lane: string,
    fragments: MemoryPublicationFragment[],
    source?: MemorySourceIndexHeader,
  ) => {
    ensureSpool();
    if (source) {
      db.prepare(`INSERT INTO ${spool} (lane, header) VALUES (?, ?)`).run(
        lane,
        JSON.stringify(source),
      );
    }
    // The transfer owner caps each request at 512 KiB; booleans never cross the SQL boundary.
    for (const fragment of fragments) {
      db.prepare(`INSERT INTO ${spool} (lane, json, last) VALUES (?, ?, ?)`).run(
        lane,
        fragment.json,
        Number(fragment.last),
      );
    }
  };
  function* records(lane: string) {
    let cursor = 0;
    for (;;) {
      const rows = db
        .prepare(
          `SELECT ordinal, header, json, last FROM ${spool} WHERE lane = ? AND ordinal > ? ORDER BY ordinal LIMIT 32`,
        )
        .all(lane, cursor);
      if (!rows.length) {
        return;
      }
      for (const row of rows) {
        cursor = Number(row.ordinal);
        yield { header: row.header, json: row.json, last: row.last };
      }
    }
  }
  function* decode<Row>(fragments: Iterable<{ json: unknown; last: unknown }>): Generator<Row> {
    let parts: string[] = [];
    for (const fragment of fragments) {
      if (typeof fragment.json !== "string") {
        continue;
      }
      parts.push(fragment.json);
      if (fragment.last) {
        // SAFETY: The paired producer serializes typed rows; only one row is retained here.
        yield JSON.parse(parts.join("")) as Row;
        parts = [];
      }
    }
    if (parts.length) {
      throw new Error("Incomplete memory publication record");
    }
  }
  const checkSource = (source: MemorySourceIndexHeader) => {
    if (
      source.source === "sessions" &&
      hasMemorySessionTombstone(db, source.agentId, source.sessionId)
    ) {
      throw new Error(
        "A session was forgotten while memory indexing was running; retry the memory index.",
      );
    }
  };
  const stageSource = (
    source: MemorySourceIndexHeader,
    fragments?: MemoryPublicationFragment[],
  ) => {
    checkSource(source);
    append("reindex", fragments ?? [], source);
    if (!fragments) {
      db.exec(
        `INSERT INTO ${spool} (lane, json, last) SELECT 'reindex', json, last FROM ${spool} WHERE lane = 'source' ORDER BY ordinal`,
      );
    }
    const hasRows = fragments
      ? fragments.some((row) => row.last)
      : Boolean(
          db.prepare(`SELECT 1 FROM ${spool} WHERE lane = 'source' AND last = 1 LIMIT 1`).get(),
        );
    rebuilding!.hasIndexedChunks ||= hasRows;
    rebuilding!.hasSemanticChunks ||= hasRows && source.model !== "fts-only";
  };
  const execute: Parameters<
    typeof bindSqliteWorkerDatabase<MemoryPublicationOperations>
  >[1]["execute"] = (command) => {
    if (command.type === "database.reset") {
      return write(() => {
        const query = getNodeSqliteKysely<
          Record<(typeof MEMORY_INDEX_DERIVED_TABLES)[number], unknown> & {
            memory_index_state: { id: number; revision: number };
          }
        >(db);
        let changed = false;
        // Admitted facts include optional vector projections; generated text columns
        // disappear with their source rows while the index definitions stay admitted.
        for (const table of MEMORY_INDEX_DERIVED_TABLES) {
          if (table === MEMORY_INDEX_STATE_TABLE || !tableExists(db, table)) {
            continue;
          }
          const result = executeSqliteQuerySync(db, query.deleteFrom(table));
          changed ||= (result.numAffectedRows ?? 0n) > 0n;
        }
        if (changed) {
          executeSqliteQuerySync(
            db,
            query
              .updateTable(MEMORY_INDEX_STATE_TABLE)
              .set((eb) => ({ revision: eb("revision", "+", 1) }))
              .where("id", "=", 1),
          );
        }
        return changed;
      });
    }
    if (stageId && !stages.has(stageId) && command.type !== "database.stage.start") {
      throw new Error("Memory reindex connection was lost; retry the full reindex.");
    }
    if (command.type === "database.stage.discard") {
      const retained = stages.get(command.input.stageId);
      if (retained?.created) {
        db.exec(`DROP TABLE ${retained.spool}`);
      }
      stages.delete(command.input.stageId);
      if (bindingStageId === command.input.stageId) {
        retainState = false;
      }
      return undefined;
    }
    if (command.type === "database.stage.publish" && command.input.stageId) {
      const retained = stages.get(command.input.stageId);
      if (!retained) {
        throw new Error("Memory reindex connection was lost; retry the full reindex.");
      }
      bindingStageId = command.input.stageId;
      retainState = true;
      restore(retained);
    }
    if (command.type === "schema.admit") {
      if (command.input.ftsEnabled) {
        admitSearch({
          "memory.text": memoryTextSearchSchema(command.input.ftsTokenizer ?? "unicode61"),
        });
      }
      const facts = rebuilding ?? readMemoryDatabaseFacts(db);
      return {
        ok: true,
        facts,
        value: {
          ftsAvailable: command.input.ftsEnabled,
          admission: {
            engine: "postgres",
            hasIndex: true,
            ftsAvailable: command.input.ftsEnabled,
            identity: readOpenClawAgentDatabaseIdentity({ db }),
            facts,
          },
        },
      };
    }
    if (command.type === "vector.ensure") {
      admitSearch({ "memory.vector": memoryVectorSearchSchema(command.input.dimensions) });
      if (rebuilding) {
        rebuilding.hasVectorTable = true;
      }
      return { ok: true, value: undefined, facts: rebuilding ?? readMemoryDatabaseFacts(db) };
    }
    if (command.type === "vector.prepare") {
      return { ok: true, value: { extensionPath: "", retiredLegacy: false } };
    }
    if (command.type === "connection.inspect") {
      throw new Error("PostgreSQL memory has no shadow file");
    }
    if (command.type === "database.publish") {
      throw new Error("PostgreSQL memory publication requires its connection-local stage");
    }
    if (command.type === "database.stage.start") {
      retainState = stageId !== undefined;
      return write(() => {
        ensureSpool();
        rebuilding = {
          ...readMemoryDatabaseFacts(db),
          meta: null,
          serialized: null,
          hasIndexedChunks: false,
          hasSemanticChunks: false,
          invalidatedSources: [],
          vectorState: { state: "empty" },
        };
      });
    }
    if (command.type === "database.stage.publish") {
      return write(() => {
        if (!rebuilding || !metadata) {
          throw new Error("Memory reindex stage is incomplete");
        }
        if (readMemoryDatabaseFacts(db).revision !== command.input.expectedRevision) {
          throw new MemoryIndexRevisionConflictError(
            "Memory index changed while full reindex was building; retry the full reindex.",
          );
        }
        db.exec("DELETE FROM memory_index_chunks; DELETE FROM memory_index_sources");
        const rows = records("reindex");
        let next = rows.next();
        while (!next.done) {
          if (typeof next.value.header !== "string") {
            throw new Error("Memory reindex source header is missing");
          }
          // SAFETY: Only stageSource writes headers into the reindex lane.
          const source = JSON.parse(next.value.header) as MemorySourceIndexHeader;
          checkSource(source);
          next = rows.next();
          function* fragments() {
            while (!next.done && next.value.header === null) {
              yield next.value;
              next = rows.next();
            }
          }
          new MemorySourceIndexKernel(db, {
            vector: { enabled: true, available: true },
            fts: { enabled: true, available: true },
          }).replaceRows(source, decode<MemorySourceIndexRow>(fragments()));
        }
        writeMemoryIndexMetadata(db, metadata);
        if (command.input.vectorIndexComplete) {
          markMemoryVectorIndexClean(db);
        }
        rebuilding = undefined;
      });
    }
    if (command.type === "index.facts") {
      return rebuilding ?? readMemoryDatabaseFacts(db);
    }
    if (command.type === "source.state" || command.type === "source.chunks") {
      return rebuilding ? [] : readMemoryIndex(db, command).value;
    }
    if (command.type === "source.hash") {
      return rebuilding ? undefined : readMemoryIndex(db, command).value;
    }
    if (command.type === "cache.read" || command.type === "session.current") {
      return readMemoryIndex(db, command).value;
    }
    if (command.type === "stage.start" || command.type === "cache.stage.start") {
      const outcome = write(() => {
        ensureSpool();
        db.prepare(`DELETE FROM ${spool} WHERE lane IN ('source', 'cache')`).run();
        header = command.input.header;
        stageKind = command.type === "stage.start" ? "source" : "cache";
      });
      if (!outcome.ok) {
        throw new Error(outcome.error.message);
      }
      return undefined;
    }
    if (command.type === "stage.append") {
      if (!stageKind) {
        throw new Error("Memory staging was not started");
      }
      const outcome = write(() => append(stageKind!, command.input.fragments));
      if (!outcome.ok) {
        throw new Error(outcome.error.message);
      }
      return undefined;
    }
    if (command.type === "stage.discard") {
      header = undefined;
      stageKind = undefined;
      return undefined;
    }
    if (command.type === "index.upgradeProviderKey") {
      return rebuilding
        ? { ok: true, value: false }
        : write(() => upgradeMemoryIndexProviderKey(db, command.input));
    }
    if (command.type === "index.writeMetadata") {
      return write(() => {
        if (rebuilding) {
          metadata = command.input;
          rebuilding.meta = metadata;
          rebuilding.serialized = JSON.stringify(metadata);
        } else {
          writeMemoryIndexMetadata(db, command.input);
        }
      });
    }
    if (command.type === "source.refresh") {
      return rebuilding
        ? { ok: true, value: false }
        : write(() => refreshMemorySessionSourceState(db, command.input));
    }
    if (command.type === "source.delete") {
      return rebuilding
        ? { ok: true, value: false }
        : write(() =>
            new MemorySourceIndexKernel(db, command.input.state).deleteIfCurrent(command.input),
          );
    }
    if (command.type === "cache.clear") {
      return write(() => {
        clearMemoryEmbeddingCacheIdentities(db, command.input.identities);
        return true;
      });
    }
    if (command.type === "cache.prune") {
      return write(() => {
        const size = countMemoryEmbeddingCache(db);
        if (size <= command.input.maxEntries) {
          return false;
        }
        pruneMemoryEmbeddingCache(db, size, command.input.maxEntries);
        return true;
      });
    }
    if (command.type === "cache.write" || command.type === "cache.write.inline") {
      return write(() => {
        const cacheHeader =
          command.type === "cache.write.inline"
            ? command.input.header
            : (header as MemoryPublicationOperations["cache.stage.start"]["input"]["header"]); // SAFETY: Paired cache.stage.start header.
        if (!cacheHeader) {
          throw new Error("Memory cache staging was not started");
        }
        const readEntries = () =>
          command.type === "cache.write.inline"
            ? command.input.entries
            : decode<MemoryEmbeddingCacheEntry>(records("cache"));
        function* entries() {
          for (const entry of readEntries()) {
            if (
              !entry.sessionId ||
              !hasMemorySessionTombstone(db, cacheHeader.agentId, entry.sessionId)
            ) {
              yield entry;
            }
          }
        }
        upsertMemoryEmbeddingCache({
          ...cacheHeader,
          db,
          cacheSize: countMemoryEmbeddingCache(db),
          entries,
        });
        return true;
      });
    }
    return write(() => {
      const sources =
        command.type === "source.replace.group"
          ? command.input.sources
          : command.type === "source.replace.inline"
            ? [command.input]
            : [{ header: header as MemorySourceIndexHeader, fragments: undefined }]; // SAFETY: Paired source stage.start header.
      for (const source of sources) {
        if (!source.header) {
          throw new Error("Memory source staging was not started");
        }
        if (rebuilding) {
          stageSource(source.header, source.fragments);
        } else {
          checkSource(source.header);
          new MemorySourceIndexKernel(db, command.input.state).replaceRows(
            source.header,
            decode<MemorySourceIndexRow>(source.fragments ?? records("source")),
          );
        }
      }
      return true;
    });
  };
  return bindSqliteWorkerDatabase<MemoryPublicationOperations>(db, {
    execute(command) {
      try {
        return execute(command);
      } finally {
        if (retainState && bindingStageId) {
          stages.set(bindingStageId, { spool, created, header, stageKind, rebuilding, metadata });
        }
      }
    },
    close() {
      if (!bindingStageId && created && db.isOpen) {
        db.exec(`DROP TABLE ${spool}`);
      }
    },
  });
}
