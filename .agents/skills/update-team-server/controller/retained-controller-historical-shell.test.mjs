import assert from "node:assert/strict";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "./retained-repair-lifecycle-test-support.mjs";
import { adopt, historicalShellFixture, prepare, preserved } from "./retained-controller-historical-shell-test-support.mjs";

for (const laterClosure of [false, true]) test(`historical successor reaches actual retained prepare shell; later closure=${laterClosure}`, t => {
  const f = historicalShellFixture(t, { laterClosure });
  adopt(f, f.historical);
  const result = prepare(f);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PREPARED .*restart=0 activation=0 original-journal=retained/);
  assert.deepEqual(preserved(f), f.before);
  assert.doesNotMatch(readFileSync(f.eventlog, "utf8"), /service\..*\.(stop|start|restart)|suspension|native\.update/);
  if (!laterClosure) return;

  const refused = pattern => {
    const result = prepare(f);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, pattern);
  };
  const bytes = readFileSync(f.library);
  writeFileSync(f.library, Buffer.concat([bytes, Buffer.from("\n// unapproved mixed closure\n")]));
  refused(/completion does not match/);
  writeFileSync(f.library, bytes);
  renameSync(f.lockFile, f.lockFile + ".saved");
  writeFileSync(f.lockFile, "replacement", { mode: 0o600 });
  refused(/controller adoption lock inode changed/);
  renameSync(f.lockFile + ".saved", f.lockFile);
  const db = new DatabaseSync(f.databasePath);
  db.exec("DELETE FROM diagnostic_events"); db.close();
  refused(/lacks a native runtime-owner atomic replacement audit/);
  assert.deepEqual(preserved(f), f.before);
  assert.doesNotMatch(readFileSync(f.eventlog, "utf8"), /service\..*\.(stop|start|restart)|suspension|native\.update/);
});
