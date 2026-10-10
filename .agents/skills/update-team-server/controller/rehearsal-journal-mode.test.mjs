import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import test from "node:test";

const source = fs.readFileSync(process.env.REHEARSAL_INPUT_TEST_LIBRARY ?? new URL("./release-lib.mjs", import.meta.url), "utf8");
const moduleRoot = fs.mkdtempSync(join(tmpdir(), "rehearsal-mode-owner-"));
const driver = source.lastIndexOf("\ntry {\n");
const rehearsal = source.indexOf("async function migrationRehearse(");
const copyStart = source.indexOf("  const map = value => join(inputs.copyRoot, value.slice(1));", rehearsal);
const copyEnd = source.indexOf("  copyInventory.config =", copyStart);
assert.ok(driver > 0 && copyStart > rehearsal && copyEnd > copyStart);
// Test-only exports preserve real owner bodies, including its actual clone loop.
fs.writeFileSync(join(moduleRoot, "owner.mjs"), source.slice(0, driver) + `
export { migrationSnapshot, migrationOpenDatabase, migrationDatabaseRead, migrationVerifyPreservation, migrationCopyInputs, identity };
${source.includes("function migrationRehearsalCopy(") ? `export { migrationRehearsalCopy };
export function copyWithOpenBoundary(open, ...args) {
  const original = migrationOpenDatabase;
  try { migrationOpenDatabase = open; return migrationRehearsalCopy(...args); }
  finally { migrationOpenDatabase = original; }
}` : ""}
export function copyRehearsalInventory(inventory, backups, inputs, release) {
${source.slice(copyStart, copyEnd)}
  return copyInventory;
}
`);
const owner = await import(pathToFileURL(join(moduleRoot, "owner.mjs")));
// No vector tables are present. Exercise real SQLite snapshot, mode and byte
// behavior without borrowing an operator's retained candidate or dependencies.
const release = join(moduleRoot, "release");
fs.mkdirSync(join(release, "node_modules/sqlite-vec"), { recursive: true });
fs.writeFileSync(join(release, "node_modules/sqlite-vec/index.js"), "exports.load=db=>db.function('vec_version',()=> 'fixture');");
const hash = path => createHash("sha256").update(fs.readFileSync(path)).digest("hex");
function inspect(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = db.prepare("SELECT rowid,id,payload FROM retained_rows ORDER BY rowid");
    rows.setReadBigInts(true);
    return { mode: db.prepare("PRAGMA journal_mode").get().journal_mode, rows: rows.all() };
  } finally { db.close(); }
}
function seed(t, mode) {
  const root = fs.mkdtempSync(join(tmpdir(), "rehearsal-mode-proof-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const path = join(root, "source.sqlite"), db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=${mode}; PRAGMA user_version=17;
    CREATE TABLE schema_meta(meta_key TEXT PRIMARY KEY,role TEXT,schema_version INTEGER,agent_id TEXT,created_at INTEGER);
    INSERT INTO schema_meta VALUES('primary','global',17,NULL,1);
    CREATE TABLE retained_rows(id TEXT PRIMARY KEY,payload BLOB);`);
  const insert = db.prepare("INSERT INTO retained_rows(rowid,id,payload) VALUES(?,?,?)");
  insert.setReadBigInts(true);
  insert.run(-7n, "first", Buffer.from('exact UTF8 🦞 and whitespace\n'));
  insert.run(9007199254740993n, "second", Buffer.from([0, 128, 255]));
  db.close();
  const alias = join(root, "source-alias.sqlite"); fs.symlinkSync(path, alias);
  const store = { ...owner.identity(path), agentId: null, version: 17,
    aliases: [{ path, owner: null, source: "shared" }, { path: alias, owner: null, source: "fixture" }] };
  return { root, path, alias, store };
}

for (const mode of ["wal", "delete"]) test(`actual rehearsal owner preserves ${mode} while backups remain immutable DELETE`, async t => {
  const f = seed(t, mode), initial = inspect(f.path), sourceHash = hash(f.path);
  const backup = await owner.migrationSnapshot(f.store, release, join(f.root, "snapshots/0.sqlite"));
  const backupHash = hash(backup.file.path), copyRoot = join(f.root, "private-execution");
  const copied = owner.copyRehearsalInventory({ stores: [f.store] }, [backup], { copyRoot }, release);
  const target = join(copyRoot, f.path.slice(1));
  assert.equal(inspect(target).mode, mode, "source mode must survive immutable-backup normalization into working copy");
  assert.equal(backup.sourceJournalMode, mode);
  assert.deepEqual(Object.keys(backup.file).sort(), ["device", "inode", "path", "sha256", "size"]);
  // Historical cold evidence has no mode fact; its existing preservation reader stays valid.
  const schemas = { state: 17, agent: 22 }, profile = { from: schemas, to: schemas };
  const legacy = { ...backup }; delete legacy.sourceJournalMode;
  owner.migrationVerifyPreservation({ schemaProfile: profile, stores: [f.store] }, [legacy], release, profile);
  assert.equal(inspect(backup.file.path).mode, "delete");
  assert.deepEqual(inspect(target).rows, initial.rows);
  assert.deepEqual(inspect(backup.file.path).rows, initial.rows);
  assert.equal(copied.stores[0].inode, fs.statSync(target).ino);
  const alias = join(copyRoot, f.alias.slice(1));
  assert.equal(fs.readlinkSync(alias), f.path);
  assert.equal(fs.statSync(join(copyRoot, fs.readlinkSync(alias).slice(1))).ino, copied.stores[0].inode);
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.equal(hash(f.path), sourceHash);
  assert.equal(hash(backup.file.path), backupHash);
  assert.equal(backup.file.sha256, backupHash);
  for (const suffix of ["-wal", "-shm", "-journal"]) assert.equal(fs.existsSync(backup.file.path + suffix), false);
});

test("fresh clone refuses missing or unknown captured mode without inventing a fallback", async t => {
  const f = seed(t, "wal"), sourceHash = hash(f.path);
  const snapshot = await owner.migrationSnapshot(f.store, release, join(f.root, "snapshot.sqlite"));
  const backupHash = hash(snapshot.file.path);
  for (const mode of [undefined, "persist", "truncate", "memory", "off", "wal;SELECT 1"]) {
    const target = join(f.root, "refused", `${String(mode).replaceAll("/", "-")}.sqlite`);
    assert.throws(() => owner.migrationRehearsalCopy({ ...snapshot, sourceJournalMode: mode }, f.store, release, target),
      /requires captured source journal mode/);
    assert.equal(fs.existsSync(target), false);
  }
  assert.equal(hash(f.path), sourceHash);
  assert.equal(hash(snapshot.file.path), backupHash);
});

test("actual SQLite mode-change failure refuses the new copy and preserves originals", async t => {
  const f = seed(t, "wal"), sourceHash = hash(f.path);
  const snapshot = await owner.migrationSnapshot(f.store, release, join(f.root, "snapshot.sqlite"));
  const backupHash = hash(snapshot.file.path), target = join(f.root, "failed-copy.sqlite");
  // Fault only the opening boundary: a genuine SQLite transaction prevents switching
  // to WAL. No return value or database operation is mocked into a refusal.
  const originalOpen = owner.migrationOpenDatabase;
  const open = (path, selectedRelease, readOnly) => {
    const opened = originalOpen(path, selectedRelease, readOnly);
    if (path === target && readOnly === false) opened.database.exec("BEGIN");
    return opened;
  };
  assert.throws(() => owner.copyWithOpenBoundary(open, snapshot, f.store, release, target), /transaction|journal mode/);
  assert.equal(inspect(target).mode, "delete");
  assert.deepEqual(inspect(target).rows, inspect(f.path).rows);
  assert.equal(hash(f.path), sourceHash);
  assert.equal(hash(snapshot.file.path), backupHash);
  assert.throws(() => owner.migrationRehearsalCopy(snapshot, f.store, release, target), /EEXIST/);
});

test("workspace traversal is rejected before creating a directory outside the rehearsal root", t => {
  const root = fs.mkdtempSync(join(tmpdir(), "rehearsal-workspace-proof-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeHome = join(root, "runtime"), stateRoot = join(runtimeHome, ".openclaw");
  const directory = join(root, "rehearsal"), escaped = join(root, "escaped");
  const workspace = "/" + relative(join(directory, "rootfs"), escaped);
  fs.mkdirSync(join(stateRoot, "agents"), { recursive: true });
  if (process.getuid() === 0) fs.chownSync(stateRoot, 65534, 65534);
  const configPath = join(stateRoot, "openclaw.json"), databasePath = join(stateRoot, "state.sqlite");
  fs.writeFileSync(configPath, JSON.stringify({ agents: { defaults: { workspace }, entries: {} } }));
  const database = new DatabaseSync(databasePath);
  database.exec("CREATE TABLE config_machine_state(state_key TEXT, value_json TEXT); CREATE TABLE plugin_state_entries(plugin_id TEXT, namespace TEXT, value_json TEXT);");
  database.close();
  const inventory = { stateRoot, config: { path: configPath }, stores: [{ path: databasePath, aliases: [], agentId: null }] };
  assert.throws(() => owner.migrationCopyInputs(inventory, release, runtimeHome, directory), /path escapes release root/);
  assert.equal(fs.existsSync(escaped), false, "refused workspace must not create a directory outside private staging");
});

test.after(() => fs.rmSync(moduleRoot, { recursive: true, force: true }));
