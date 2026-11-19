import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, mkdirSync, renameSync, copyFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { makeReleaseFixture } from './worker-config-owner-fixture.mjs';

function invoke(f, command, input) {
  const result = spawnSync(process.execPath, ['--no-warnings', f.library, command, f.initial, f.initial, f.databasePath], { env: f.env, input, encoding: 'utf8', timeout: 30_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function hold(f, mode) {
  const shared = new DatabaseSync(f.databasePath);
  if (mode === 'journal') {
    shared.exec('CREATE TABLE agent_deletion_journal (agent_id TEXT, agent_dir TEXT, database_paths_json TEXT, cleanup_completed INTEGER, delete_files INTEGER)');
    shared.prepare('INSERT INTO agent_deletion_journal VALUES (?, ?, ?, 1, 0)').run('controller-test-agent', dirname(f.agentDatabasePath), JSON.stringify([f.agentDatabasePath]));
  } else {
    shared.exec('CREATE TABLE migration_sources (source_key TEXT, report_json TEXT)');
    shared.prepare('INSERT INTO migration_sources VALUES (?, ?)').run('agent-deletion-journal-reconstruction', JSON.stringify({ held: [{ agentId: 'controller-test-agent', path: f.agentDatabasePath }] }));
  }
  shared.close();
  const agent = new DatabaseSync(f.agentDatabasePath);
  agent.exec('PRAGMA user_version=0; UPDATE schema_meta SET schema_version=0');
  agent.close();
}
for (const mode of ['journal', 'reconstructed']) {
  test('held database remains untouched and outside schema admission: ' + mode, t => {
    const f = makeReleaseFixture(t);
    hold(f, mode);
    const bytes = readFileSync(f.agentDatabasePath), before = lstatSync(f.agentDatabasePath, { bigint: true });
    const state = JSON.parse(invoke(f, 'compatibility'));
    assert.equal(state.heldAgentDatabases, 1);
    const witness = invoke(f, 'session-preservation-witness');
    assert.deepEqual(JSON.parse(JSON.parse(witness)[0]).slice(4), ['', '', null, null, 'held']);
    assert.equal(invoke(f, 'session-preservation-verify', witness), 'SESSIONS_PRESERVED');
    assert.deepEqual(readFileSync(f.agentDatabasePath), bytes);
    assert.equal(lstatSync(f.agentDatabasePath, { bigint: true }).mtimeNs, before.mtimeNs);
  });
}
test('archived held database preserves captured identity and refuses replacement', t => {
  const f = makeReleaseFixture(t);
  const witness = invoke(f, 'session-preservation-witness');
  hold(f, 'journal');
  const root = dirname(dirname(f.databasePath));
  const archive = join(root, 'held-agent-archive', 'controller-test-agent-held-fixture');
  mkdirSync(dirname(archive), { mode: 0o700 });
  renameSync(dirname(dirname(f.agentDatabasePath)), archive);
  chmodSync(archive, 0o700);
  chmodSync(join(archive, "agent"), 0o700);
  const target = join(archive, 'agent', 'openclaw-agent.sqlite');
  const bytes = readFileSync(target), before = lstatSync(target, { bigint: true });
  assert.equal(invoke(f, 'session-preservation-verify', witness), 'SESSIONS_PRESERVED');
  assert.deepEqual(readFileSync(target), bytes);
  assert.equal(lstatSync(target, { bigint: true }).mtimeNs, before.mtimeNs);
  copyFileSync(target, target + '.replacement');
  renameSync(target + '.replacement', target);
  const rejected = spawnSync(process.execPath, ['--no-warnings', f.library, 'session-preservation-verify', f.initial, f.initial, f.databasePath], { env: f.env, input: witness, encoding: 'utf8', timeout: 30_000 });
  assert.ifError(rejected.error);
  assert.notEqual(rejected.status, 0);
});
