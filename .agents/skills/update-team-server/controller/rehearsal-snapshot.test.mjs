import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { makeRehearsalSnapshotFixture as fixture } from "./rehearsal-snapshot.test-support.mjs";

const library = process.env.REHEARSAL_SNAPSHOT_TEST_LIBRARY ?? new URL("./release-lib.mjs", import.meta.url).pathname;


test("captures registered stores and committed WAL without portable sanitization or live lifecycle changes", t => {
  const f = fixture(t);
  const source = f.agents[0];
  const rawCopy = join(f.root, "main-file-only.sqlite");
  copyFileSync(source.file, rawCopy);
  const raw = new DatabaseSync(rawCopy, { readOnly: true });
  assert.equal(raw.prepare("SELECT count(*) AS n FROM retained").get().n, 0);
  raw.close();
  const permit = readFileSync(f.permit), current = readFileSync(join(f.state, "running"));
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout), manifest = JSON.parse(readFileSync(receipt.manifest));
  assert.equal(receipt.sourceWritersStopped, false);
  assert.equal(manifest.consistency, "per-database-committed");
  assert.equal(manifest.backups.length, 3);
  for (const agent of f.agents) {
    const snapshot = manifest.backups.find(value => value.source === agent.file);
    const copied = new DatabaseSync(snapshot.file.path, { readOnly: true });
    assert.deepEqual(Buffer.from(copied.prepare("SELECT payload FROM retained").get().payload), Buffer.from(`committed WAL bytes ${agent.id} 🦞`));
    copied.close();
  }
  const copiedShared = new DatabaseSync(manifest.backups.find(value => value.source === f.shared).file.path, { readOnly: true });
  assert.equal(copiedShared.prepare("SELECT payload FROM delivery_queue_entries").get().payload, "preserve queued work");
  copiedShared.close();
  assert.deepEqual(readFileSync(f.permit), permit);
  assert.deepEqual(readFileSync(join(f.state, "running")), current);
  assert.equal(existsSync(f.journal), false);
  const bytes = readFileSync(receipt.manifest);
  assert.notEqual(f.run().status, 0);
  assert.deepEqual(readFileSync(receipt.manifest), bytes);
});

test("refuses an activation journal before producing rehearsal artifacts", t => {
  const f = fixture(t);
  writeFileSync(f.journal, "retained live transaction", { mode: 0o600 });
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(join(f.serving, "journal/rehearsal-warm")), false);
  assert.equal(readFileSync(f.journal, "utf8"), "retained live transaction");
});

test("retains live-writer free-space reserve before producing snapshot files", t => {
  const f = fixture(t);
  const result = f.run("full-disk", 1);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /destination capacity.*operational reserve/);
  assert.equal(existsSync(join(f.serving, "journal/rehearsal-full-disk")), false);
});


test("verifies copied physical owners against immutable native snapshot evidence", t => {
  const f = fixture(t);
  const captured = f.run();
  assert.equal(captured.status, 0, captured.stderr);
  const receipt = JSON.parse(captured.stdout), manifest = JSON.parse(readFileSync(receipt.manifest));
  for (const agent of f.agents) agent.writer.close();
  for (const backup of manifest.backups) {
    const replacement = backup.source + ".copy";
    copyFileSync(backup.file.path, replacement);
    renameSync(replacement, backup.source);
  }
  const snapshotBoundary = join(f.root, "readonly-snapshot.mjs");
  // Unit fixture models the Btrfs boundary; the target rehearsal qualifies the real kernel mount.
  writeFileSync(snapshotBoundary, `import fs from 'node:fs';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
const stat=fs.statfsSync,lstat=fs.lstatSync,spawn=cp.spawnSync,device=lstat(${JSON.stringify(f.root)}).dev;
fs.statfsSync=(...args)=>({...stat(...args),type:0x9123683e});
fs.lstatSync=(file,...args)=>{const entry=lstat(file,...args);if(file==='/')entry.dev=device;return entry;};
cp.spawnSync=(file,args,opts)=>{
 if(file==='/usr/bin/btrfs')return args[0]==='property'?{status:0,stdout:process.env.SNAPSHOT_TEST_READONLY==='false'?'ro=false':'ro=true'}:
  args.at(-1)==='/'?{status:0,stdout:'256'}:{status:1,stderr:'EROFS: btrfs rootid opens regular files read/write'};
 if(file==='/usr/bin/python3')return{status:0,stdout:JSON.stringify(args.slice(2).map(path=>{const entry=fs.lstatSync(path);return{rootId:process.env.SNAPSHOT_TEST_WRONG_ROOT==='true'&&path!=='/'?'257':'256',device:entry.dev,inode:entry.ino};}))};
 return spawn(file,args,opts);
};syncBuiltinESMExports();`);
  const verify = (hash, preload, readonly = true, wrongRoot = false) => spawnSync(process.execPath, ["--import", snapshotBoundary, ...(preload ? ["--import", preload] : []), library, "verify-rehearsal-snapshot", receipt.manifest, f.initial, f.initial, hash], { env: { ...f.env, SNAPSHOT_TEST_READONLY: String(readonly), SNAPSHOT_TEST_WRONG_ROOT: String(wrongRoot) }, encoding: "utf8", timeout: 30000 });
  const checked = verify(receipt.manifestSha256);
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(JSON.parse(checked.stdout).sourceSessionWitnesses, 2);
  assert.match(verify(receipt.manifestSha256, undefined, false).stderr, /frozen read-only Btrfs/);
  assert.match(verify(receipt.manifestSha256, undefined, true, true).stderr, /outside its frozen root subvolume/);
  assert.notEqual(verify("b".repeat(64)).status, 0);
  const replacementRace = join(f.root, "replace-after-preservation.mjs");
  writeFileSync(replacementRace, `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; import {DatabaseSync} from 'node:sqlite';
const target=${JSON.stringify(f.agents[0].file)}, next=${JSON.stringify(manifest.backups[1].file.path)};
const prepared=new WeakSet(), prepare=DatabaseSync.prototype.prepare, close=DatabaseSync.prototype.close, lstat=fs.lstatSync;
let ready=false,replaced=false;
DatabaseSync.prototype.prepare=function(sql){if(sql==='PRAGMA integrity_check'&&this.location()===target)prepared.add(this);return prepare.call(this,sql);};
DatabaseSync.prototype.close=function(){const mark=prepared.has(this);const result=close.call(this);if(mark)ready=true;return result;};
fs.lstatSync=function(file,...args){if(file===next&&ready&&!replaced){fs.copyFileSync(target,target+'.replacement');fs.renameSync(target+'.replacement',target);replaced=true;}return lstat.call(fs,file,...args);};syncBuiltinESMExports();`);
  const raced = verify(receipt.manifestSha256, replacementRace);
  assert.notEqual(raced.status, 0);
  assert.match(raced.stderr, /physical database.*changed/);
  const changed = new DatabaseSync(f.shared);
  changed.exec("DELETE FROM delivery_queue_entries"); changed.close();
  const rejected = verify(receipt.manifestSha256);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /protected table|logical|table/);
});
