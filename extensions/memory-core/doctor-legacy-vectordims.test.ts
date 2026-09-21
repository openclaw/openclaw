import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  ensureMemoryIndexSchema,
  loadSqliteVecExtension,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  createPluginStateKeyedStoreForTests,
  getPluginStateCapacityForTests,
  importPluginStateEntriesForDoctorForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type {
  OpenKeyedStoreOptions,
  PluginDoctorStateMigrationContext,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseAsync,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stateMigrations } from "./doctor-contract-api.js";

// A legacy sidecar declares its vector width in a JSON meta blob. A declaration that
// is not a plain base-10 integer must be rejected rather than coerced: `Number()`
// turns "0x600", "1.536e3", and "0b11000000000" into 1536, which makes a malformed
// declaration indistinguishable from a genuine one matching the canonical table.
//
// This fixture deliberately separates the two ways a width can be learned:
//   - the canonical table declares 1536 (what the declaration is compared against)
//   - the legacy embedding blob is 12 bytes, so the byte-length fallback says 3
// Neither equals the other, so the *declared spelling alone* decides the outcome.
// With a blob-derived width equal to the canonical one, rejecting the declaration
// would be unobservable and the test would pass without exercising the parser.
const NON_CANONICAL_1536_SPELLINGS = ["0x600", "1.536e3", "0b11000000000"];
const CANONICAL_DIMENSIONS = 1536;
const FALLBACK_DIMENSIONS = 3;

function createDoctorContext(env: NodeJS.ProcessEnv): PluginDoctorStateMigrationContext {
  return {
    getPluginStateCapacity() {
      return getPluginStateCapacityForTests("memory-core", env);
    },
    importPluginStateEntries(options, entries) {
      importPluginStateEntriesForDoctorForTests(
        "memory-core",
        { ...options, env: options.env ?? env },
        entries,
      );
    },
    openPluginStateKeyedStore<T>(options: OpenKeyedStoreOptions) {
      return createPluginStateKeyedStoreForTests<T>("memory-core", {
        ...options,
        env: options.env ?? env,
      });
    },
  };
}

function legacyMemoryIndexMigration() {
  const migration = stateMigrations.find(
    (entry) => entry.id === "memory-core-legacy-sidecar-index-to-agent-sqlite",
  );
  if (!migration) {
    throw new Error("expected memory-core legacy sidecar migration");
  }
  return migration;
}

async function resetDoctorPluginState() {
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
}

/** Writes a legacy sidecar whose meta declares `vectorDims` as the given spelling. */
async function writeLegacyMemorySidecarWithDeclaredDims(
  legacyPath: string,
  spelling: string,
): Promise<void> {
  await fs.mkdir(path.dirname(legacyPath), { recursive: true });
  const db = new DatabaseSync(legacyPath);
  try {
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE files (
        path TEXT PRIMARY KEY,
        source TEXT NOT NULL DEFAULT 'memory',
        hash TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL
      );
      CREATE TABLE chunks (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'memory',
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        hash TEXT NOT NULL,
        model TEXT NOT NULL,
        text TEXT NOT NULL,
        embedding TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE chunks_vec (id TEXT PRIMARY KEY, embedding BLOB);
    `);
    db.prepare("INSERT INTO meta VALUES ('memory_index_meta_v1', ?)").run(
      JSON.stringify({ vectorDims: spelling }),
    );
    db.prepare("INSERT INTO files VALUES ('MEMORY.md', 'memory', 'file-hash', 10, 20)").run();
    db.prepare(
      "INSERT INTO chunks VALUES ('chunk-1', 'MEMORY.md', 'memory', 1, 2, 'chunk-hash', 'embed-model', 'remember this', '[1,0,0]', 30)",
    ).run();
    // 12 bytes -> the byte-length fallback reads 3, which differs from the canonical
    // 1536 width on purpose, so the declared spelling is what decides the outcome.
    db.prepare("INSERT INTO chunks_vec VALUES ('chunk-1', ?)").run(
      Buffer.from(new Float32Array([1, 0, 0]).buffer),
    );
  } finally {
    db.close();
  }
}

/** Creates a canonical index whose vec0 table declares `dimensions`. */
async function createCanonicalVectorIndexWithDims(
  agentPath: string,
  dimensions: number,
): Promise<void> {
  await fs.mkdir(path.dirname(agentPath), { recursive: true });
  const db = new DatabaseSync(agentPath, { allowExtension: true });
  try {
    ensureMemoryIndexSchema({ db, cacheEnabled: true, ftsEnabled: true });
    const loaded = await loadSqliteVecExtension({ db });
    expect(loaded.ok, loaded.error).toBe(true);
    db.exec(`
      CREATE VIRTUAL TABLE memory_index_chunks_vec USING vec0(
        id TEXT PRIMARY KEY,
        embedding FLOAT[${dimensions}]
      )
    `);
  } finally {
    db.close();
  }
}

describe("memory-core legacy sidecar vector width declarations", () => {
  let rootDir = "";
  let workspaceDir = "";
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    await resetDoctorPluginState();
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-core-vectordims-"));
    workspaceDir = path.join(rootDir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    env = { ...process.env, OPENCLAW_STATE_DIR: path.join(rootDir, "state") };
  });

  afterEach(async () => {
    await resetDoctorPluginState();
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  function migrationParams(config?: OpenClawConfig) {
    return {
      config: config ?? { agents: { list: [{ id: "main", workspace: workspaceDir }] } },
      env,
      stateDir: path.join(rootDir, "state"),
      oauthDir: path.join(rootDir, "oauth"),
      context: createDoctorContext(env),
    };
  }

  it.each(NON_CANONICAL_1536_SPELLINGS)(
    "refuses a legacy sidecar whose declared vector width is the non-canonical spelling %s",
    async (spelling) => {
      const stateDir = path.join(rootDir, "state");
      const legacyPath = path.join(stateDir, "memory", "main.sqlite");
      const agentPath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
      await writeLegacyMemorySidecarWithDeclaredDims(legacyPath, spelling);
      await createCanonicalVectorIndexWithDims(agentPath, CANONICAL_DIMENSIONS);

      const result = await legacyMemoryIndexMigration().migrateLegacyState(migrationParams());

      // Coercing this spelling yields 1536, which coincides with the canonical table,
      // so the mismatch guard passes and rows are copied into a column of the wrong
      // width. Rejecting it falls back to the blob-derived width instead, which no
      // longer matches, so the import is refused before any row is copied.
      expect(result.warnings).toEqual([
        expect.stringContaining(
          `legacy memory chunks_vec dimensions ${FALLBACK_DIMENSIONS} do not match canonical memory chunks_vec dimensions ${CANONICAL_DIMENSIONS}`,
        ),
      ]);
      expect(result.changes).toEqual([]);
      await fs.access(legacyPath);
      await expect(fs.access(`${legacyPath}.migrated`)).rejects.toThrow();
    },
  );
});
