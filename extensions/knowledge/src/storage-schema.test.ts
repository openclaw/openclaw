import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { copyFile, rename } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { SqliteIdentityStore } from "./identity-store.js";
import { RegistryRecoveryRequired, StoreRegistry } from "./store-registry.js";
import { useTestTempDirs } from "./test-support.js";

const tempDirs = useTestTempDirs();

// Native header application IDs earlier Knowledge releases stamped.
const STATE_APPLICATION_ID = 0x4b4e4f57;
const REGISTRY_APPLICATION_ID = 0x4b4e5247;
// Schema steps exactly as earlier Knowledge releases wrote them, header fields included.
const LEGACY_STATE_STEPS = [
  `PRAGMA application_id=${STATE_APPLICATION_ID}; PRAGMA user_version=1;
   CREATE TABLE identities (agent_key TEXT PRIMARY KEY, manifest TEXT NOT NULL) STRICT;`,
  `CREATE TABLE IF NOT EXISTS mutations (scope TEXT NOT NULL, request TEXT NOT NULL, intent TEXT NOT NULL,
     state TEXT NOT NULL, plan TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(scope, request)) STRICT;
   CREATE TABLE IF NOT EXISTS observations (scope TEXT NOT NULL, id TEXT NOT NULL, path TEXT NOT NULL, hash TEXT NOT NULL,
     revision INTEGER NOT NULL, raw TEXT NOT NULL, PRIMARY KEY(scope,id)) STRICT;
   CREATE TABLE IF NOT EXISTS history (sequence INTEGER PRIMARY KEY, scope TEXT NOT NULL, id TEXT NOT NULL,
     provenance TEXT NOT NULL, at TEXT NOT NULL, path TEXT NOT NULL, revision INTEGER NOT NULL, hash TEXT NOT NULL, raw TEXT NOT NULL) STRICT;
   PRAGMA user_version=2;`,
  `CREATE TABLE git_jobs (sequence INTEGER PRIMARY KEY, scope TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
     batch TEXT NOT NULL, state TEXT NOT NULL, commit_id TEXT, message TEXT NOT NULL) STRICT;
   CREATE TABLE git_files (scope TEXT NOT NULL, path TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(scope,path)) STRICT;
   PRAGMA user_version=3;`,
  `CREATE TABLE attachment_uploads (scope TEXT NOT NULL, request TEXT NOT NULL, metadata TEXT NOT NULL,
     received INTEGER NOT NULL, receipt TEXT, PRIMARY KEY(scope,request)) STRICT;
   CREATE TABLE attachment_chunks (scope TEXT NOT NULL, request TEXT NOT NULL, offset INTEGER NOT NULL,
     hash TEXT NOT NULL, size INTEGER NOT NULL, final INTEGER NOT NULL, data BLOB, PRIMARY KEY(scope,request,offset)) STRICT;
   PRAGMA user_version=4;`,
  `ALTER TABLE history ADD COLUMN agent_id TEXT; PRAGMA user_version=5;`,
];

const manifest = () => ({
  format: "knowledge-vault-v2" as const,
  vaultId: randomUUID(),
  generation: 0,
  publicationId: randomUUID(),
});

function legacyState(file: string, version: number, value: object) {
  const db = new DatabaseSync(file);
  for (const step of LEGACY_STATE_STEPS.slice(0, version)) {
    db.exec(`BEGIN IMMEDIATE; ${step} COMMIT;`);
  }
  db.prepare("INSERT INTO identities VALUES (?,?)").run("store:legacy", JSON.stringify(value));
  db.close();
}

function inspect(file: string) {
  const db = new DatabaseSync(file);
  try {
    return {
      userVersion: db.prepare("PRAGMA user_version").get()?.user_version,
      stamp: db.prepare("SELECT store, version FROM knowledge_schema").all(),
      agentColumn: db
        .prepare("SELECT name FROM pragma_table_info('history') WHERE name='agent_id'")
        .get(),
      tables: db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all()
        .map((row) => row.name),
    };
  } finally {
    db.close();
  }
}

it.each([1, 2, 3, 4, 5])(
  "a state database written at legacy version %i opens, keeps its identity and is brought current",
  async (version) => {
    const file = path.join(tempDirs.make("knowledge-schema-"), "state.sqlite");
    const value = manifest();
    legacyState(file, version, value);

    expect(await new SqliteIdentityStore(file).lookup("store:legacy")).toStrictEqual(value);
    const after = inspect(file);
    // The native header is untouched; a store already at version 5 stays readable by the last standalone release.
    expect(after.userVersion).toBe(version);
    expect(after.stamp).toEqual([{ store: "state", version: 5 }]);
    expect(after.agentColumn).toBeDefined();
    expect(after.tables).toStrictEqual([
      "attachment_chunks",
      "attachment_uploads",
      "git_files",
      "git_jobs",
      "history",
      "identities",
      "keyword_state_v1",
      "keyword_withdrawals_v1",
      "knowledge_schema",
      "lifecycle_guards_v1",
      "mutations",
      "observations",
      "recent_records_v1",
      "recent_requests_v1",
      "session_activity",
    ]);
  },
);

it("a legacy database written into an already admitted inode is admitted again", async () => {
  const dir = tempDirs.make("knowledge-schema-");
  const file = path.join(dir, "state.sqlite");
  const store = new SqliteIdentityStore(file);
  await store.registerIfAbsent("store:new", manifest());
  // copyFile truncates and rewrites the destination in place, keeping its
  // inode: the same identity a recycled inode presents after delete/recreate.
  const legacy = path.join(dir, "legacy.sqlite");
  const value = manifest();
  legacyState(legacy, 1, value);
  await copyFile(legacy, file);
  expect(await new SqliteIdentityStore(file).lookup("store:legacy")).toStrictEqual(value);
  expect(inspect(file).stamp).toEqual([{ store: "state", version: 5 }]);
});

it("a new state database has the full schema and durable connection defaults", async () => {
  const file = path.join(tempDirs.make("knowledge-schema-"), "state.sqlite");
  const store = new SqliteIdentityStore(file);
  const value = manifest();
  expect(await store.registerIfAbsent("store:new", value)).toBe(true);
  expect(await store.registerIfAbsent("store:new", manifest())).toBe(false);
  expect(await store.lookup("store:new")).toStrictEqual(value);
  const pragmas = store.withDatabase((db) => ({
    busyTimeout: db.prepare("PRAGMA busy_timeout").get()?.timeout,
    journal: db.prepare("PRAGMA journal_mode").get()?.journal_mode,
    synchronous: db.prepare("PRAGMA synchronous").get()?.synchronous,
  }));
  // Rollback journal with synchronous=FULL, as every earlier release configured explicitly.
  expect(pragmas).toStrictEqual({ busyTimeout: 5000, journal: "delete", synchronous: 2 });
  expect(inspect(file).stamp).toEqual([{ store: "state", version: 5 }]);
});

it("an interrupted first initialization recovers before classifying the empty database", async () => {
  const file = path.join(tempDirs.make("knowledge-schema-crash-"), "state.sqlite");
  const child = spawnSync("node", [
    "--input-type=module",
    "-e",
    `import { DatabaseSync } from 'node:sqlite';
     const db = new DatabaseSync(process.argv[1]);
     db.exec("PRAGMA cache_size=1; PRAGMA cache_spill=1; BEGIN IMMEDIATE; CREATE TABLE identities (agent_key TEXT PRIMARY KEY, manifest TEXT NOT NULL) STRICT; INSERT INTO identities VALUES ('interrupted', printf('%.*c', 65536, 'x'));");
     process.exit(77);`,
    file,
  ]);
  expect(child.status).toBe(77);
  expect(statSync(file).size).toBeGreaterThan(0);
  expect(await new SqliteIdentityStore(file).lookup("interrupted")).toBeUndefined();
  expect(inspect(file).stamp).toEqual([{ store: "state", version: 5 }]);
});

it("a database that is not a current Knowledge state store is refused", async () => {
  const dir = tempDirs.make("knowledge-schema-");
  const foreign = path.join(dir, "foreign.sqlite");
  const db = new DatabaseSync(foreign);
  db.exec("CREATE TABLE notes (id TEXT)");
  db.close();
  await expect(new SqliteIdentityStore(foreign).lookup("store:x")).rejects.toThrow(
    "identity checkpoint unavailable",
  );

  // Admission runs once per physical database per thread, so a newer release's
  // store is written without admitting it here first.
  const newer = path.join(dir, "newer.sqlite");
  legacyState(newer, 5, manifest());
  const stamped = new DatabaseSync(newer);
  stamped.exec(
    "CREATE TABLE knowledge_schema (store TEXT PRIMARY KEY, version INTEGER NOT NULL) STRICT; INSERT INTO knowledge_schema VALUES ('state', 6);",
  );
  stamped.close();
  await expect(new SqliteIdentityStore(newer).lookup("store:x")).rejects.toThrow(
    "identity checkpoint unavailable",
  );
});

it("schema and tables are admitted once per physical database; a replaced file is admitted again", async () => {
  // Prior fixtures may have freed inodes still remembered by their module's admission set.
  vi.resetModules();
  const { SqliteIdentityStore: IsolatedIdentityStore } = await import("./identity-store.js");
  const file = path.join(tempDirs.make("knowledge-schema-"), "state.sqlite");
  const store = new IsolatedIdentityStore(file);
  await store.lookup("store:x");
  const indexes = () => {
    const db = new DatabaseSync(file);
    try {
      return db.prepare("SELECT 1 FROM pragma_index_list('history')").all().length;
    } finally {
      db.close();
    }
  };
  const admittedIndexes = indexes();
  const db = new DatabaseSync(file);
  db.exec("DROP INDEX history_scope_sequence");
  db.close();
  await store.lookup("store:x");
  expect(indexes()).toBe(admittedIndexes - 1);
  await copyFile(file, `${file}.restored`);
  await rename(`${file}.restored`, file);
  await store.lookup("store:x");
  expect(indexes()).toBe(admittedIndexes);
});

it("a registry written by an earlier release opens, and a foreign database is refused", () => {
  const root = tempDirs.make("knowledge-registry-");
  const legacy = new DatabaseSync(path.join(root, "registry.sqlite"));
  legacy.exec(`BEGIN IMMEDIATE;
    PRAGMA application_id=${REGISTRY_APPLICATION_ID};
    CREATE TABLE stores (vault_id TEXT PRIMARY KEY, publication_id TEXT NOT NULL, root TEXT NOT NULL UNIQUE,
      state_path TEXT NOT NULL UNIQUE, state TEXT NOT NULL CHECK(state IN ('initializing','ready')), created_at TEXT NOT NULL) STRICT;
    CREATE TABLE bindings (binding TEXT PRIMARY KEY, vault_id TEXT NOT NULL UNIQUE REFERENCES stores(vault_id), label TEXT) STRICT;
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    INSERT INTO meta VALUES ('registry_id', 'legacy-registry');
    CREATE TABLE operations (request_id TEXT PRIMARY KEY, intent TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','applied','not-applied','conflict')),
      expected_revision TEXT NOT NULL, next_section TEXT NOT NULL, next_revision TEXT NOT NULL,
      rebind TEXT, message TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
    PRAGMA user_version=1;
    COMMIT;`);
  legacy.close();
  const registry = new StoreRegistry(root);
  expect(registry.reconcile("section", "r1").reconciled).toStrictEqual({
    section: "section",
    revision: "r1",
  });
  expect(registry["db"].prepare("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
  registry.close();
  expect(inspect(path.join(root, "registry.sqlite")).stamp).toEqual([
    { store: "registry", version: 1 },
  ]);
  const reopened = new StoreRegistry(root);
  expect(reopened.snapshot().reconciled?.revision).toBe("r1");
  reopened.close();

  const other = tempDirs.make("knowledge-registry-");
  const foreign = new DatabaseSync(path.join(other, "registry.sqlite"));
  foreign.exec("CREATE TABLE stores (id TEXT)");
  foreign.close();
  expect(() => new StoreRegistry(other)).toThrow(RegistryRecoveryRequired);
});
