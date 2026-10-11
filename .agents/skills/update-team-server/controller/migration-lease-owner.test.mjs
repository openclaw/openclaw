import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readlinkSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { events, makeReleaseFixture, runOwner } from "./worker-config-owner-fixture.mjs";
import { installMigrationLeaseClock } from "./migration-lease-clock.test-support.mjs";

const target = "b".repeat(40);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

function fixture(t, retained, fault = "") {
  const f = makeReleaseFixture(t, fault === "ready-late" ? "success" : "always-draining");
  mkdirSync(join(f.state, "state"));
  const databasePath = join(f.state, "state", "openclaw.sqlite");
  renameSync(f.databasePath, databasePath);
  f.databasePath = databasePath;
  f.env.OPENCLAW_TEAM_STATE_DATABASE = databasePath;
  if (process.env.MIGRATION_LEASE_TEST_OWNER) f.owner = process.env.MIGRATION_LEASE_TEST_OWNER;
  const library = process.env.MIGRATION_LEASE_TEST_LIBRARY ?? f.library;
  const call = (args, input) => {
    const result = spawnSync(process.execPath, ["--no-warnings", library, ...args], {
      env: f.env, encoding: "utf8", input, timeout: 30_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  f.candidate = f.addRelease(target);
  const releases = [];
  for (const [path, sha, state] of [[f.initial, f.sha, 17], [f.candidate, target, 18]]) {
    const cli = join(path, "dist/index.js"), source = readFileSync(cli, "utf8");
    assert.ok(source.includes("process.env.OPENCLAW_STATE_DIR!==fixture.root"));
    chmodSync(cli, 0o644);
    writeFileSync(cli, source.replace("process.env.OPENCLAW_STATE_DIR!==fixture.root", "process.env.OPENCLAW_STATE_DIR!==fixture.state"));
    chmodSync(cli, 0o444);
    for (const name of ["package.json", "deployment.json"]) {
      const file = join(path, name), value = JSON.parse(readFileSync(file));
      if (name === "package.json") value.openclaw.schemaVersions = { state, agent: 23 };
      else value.schemaVersions = { state, agent: 23 };
      chmodSync(file, 0o644); writeFileSync(file, JSON.stringify(value)); chmodSync(file, 0o444);
    }
    releases.push(call(["validate-release", path, sha, String(process.getuid()), "sealed"]));
  }
  const record = {
    version: 1, topology: "system", predecessor: releases[0], candidate: releases[1],
    process: { pid: f.pid, generation: f.start, instance: `fixture-instance-${f.pid}` },
    services: { system: { unitFileState: "enabled", activeState: "active" }, user: { unitFileState: "disabled", activeState: "inactive" } },
    suspension: null,
    protectedPaths: call(["fingerprint", f.config, f.databasePath]),
    pointerTopology: { current: { present: true, sha: f.sha }, previous: { present: false, sha: null } },
  };
  const evidence = call(["migration-create", f.serving, "@stdin"], JSON.stringify(record));
  const identity = path => { const entry = statSync(path); return { path, device: entry.dev, inode: entry.ino }; };
  const config = { ...identity(f.config), size: statSync(f.config).size, sha256: hash(readFileSync(f.config)) };
  const name = `preflight-${randomUUID()}.json`, path = join(evidence.identity.stage.path, name);
  writeFileSync(path, JSON.stringify({ version: 1, schemaProfile: { from: { state: 17, agent: 23 }, to: { state: 18, agent: 23 } },
    candidate: target, completeClosure: true, dataReady: true, config, databaseBytes: 4096 }), { mode: 0o600 });
  const entry = statSync(path);
  evidence.record.agentMigration.artifacts.preflight = { name, device: entry.dev, inode: entry.ino, sha256: hash(readFileSync(path)) };
  if (retained) {
    evidence.record.phase = "A_PREPARED";
    evidence.record.agentMigration.phase = "prepared";
    evidence.record.suspension = { id: "expired-original-lease", expiresAtMs: Date.now() - 1,
      status: "draining", terminalPolicy: "preserve" };
    unlinkSync(f.permit);
  }
  // Seed already-qualified copied evidence; this boundary must never run live Doctor.
  writeFileSync(f.journal, JSON.stringify(evidence.record));
  f.originalPreflight = evidence.record.agentMigration.artifacts.preflight;
  f.preflightPath = path;
  f.preflightBytes = readFileSync(path);

  writeFileSync(join(f.state, "lease-fault"), fault);
  installMigrationLeaseClock(f, { fault, calibrate: fault !== "ready-late" });
  const capacity = join(f.root, "lease-capacity.mjs");
  writeFileSync(capacity, `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
const statfs=fs.statfsSync;fs.statfsSync=(...args)=>{const value=statfs(...args);return {...value,bavail:Math.max(value.bavail,Math.ceil(64*1024**3/value.bsize))};};syncBuiltinESMExports();`);
  f.env.NODE_OPTIONS += ` --import=${capacity}`;
  const proxy = join(f.root, "lease-proof.cjs");
  writeFileSync(proxy, `const fs=require('node:fs'),cp=require('node:child_process');
const args=process.argv.slice(2),input=fs.readFileSync(0);
const state=${JSON.stringify(f.state)},fault=fs.readFileSync(state+'/lease-fault','utf8');
const event=value=>fs.appendFileSync(${JSON.stringify(f.eventlog)},value+'\\n');
const prepared=args[0]==='migration-transition'&&JSON.parse(input).phase==='prepared';
let publishCount=0;
if(prepared) {
 const file=state+'/prepared-publishes';publishCount=Number(fs.existsSync(file)?fs.readFileSync(file,'utf8'):0)+1;
 fs.writeFileSync(file,String(publishCount));
 if(publishCount===2&&fault==='before-renew-cas') {event('fixture.before-renew-cas');process.exit(73);}
}
if(args[0]==='migration-permit-publish')event('permit.published');
if(args[0]==='migration-permit-absent'&&fs.readFileSync(${JSON.stringify(join(f.state, "system"))},'utf8').trim()==='inactive'){
if(fs.existsSync(${JSON.stringify(f.permit)}))throw Error('stop retained a permit');
event('boundary.stopped');process.exit(73);}
if(args[0]==='migration-permit-revoke'&&fault==='before-revoke'&&!fs.existsSync(state+'/interrupted')) {
 fs.writeFileSync(state+'/interrupted','1');event('fixture.before-revoke');process.exit(73);
}
const replacement=args[0]==='migration-transition'&&fault==='reopened-lock'?fs.openSync(${JSON.stringify(f.lockFile)},'r'):undefined;
const result=cp.spawnSync(process.execPath,[${JSON.stringify(library)},...args],{input,encoding:'utf8',env:process.env,stdio:['pipe','pipe','pipe','ignore','ignore','ignore','ignore','ignore','ignore',replacement??9]});
if(replacement!==undefined)fs.closeSync(replacement);
if(result.status===0&&publishCount===2&&fault==='after-renew-cas') {event('fixture.after-renew-cas');process.exit(73);}
if(result.status===0&&args[0]==='migration-live-preflight'&&!fs.existsSync(state+'/fault-applied')) {
 fs.writeFileSync(state+'/fault-applied','1');
 if(fault==='config')fs.appendFileSync(${JSON.stringify(f.config)},' ');
 if(fault==='journal')fs.appendFileSync(${JSON.stringify(f.journal)},'\\n');
 if(fault==='preflight')fs.appendFileSync(${JSON.stringify(f.preflightPath)},'\\n');
 if(fault==='instance')fs.writeFileSync(state+'/instance-drift','1');
 if(fault==='controller') {const value=JSON.parse(result.stdout);value.controller.generation='1';result.stdout=JSON.stringify(value);}
 if(fault==='pointer-swap') {const file=${JSON.stringify(join(f.serving, "current"))};fs.unlinkSync(file);fs.symlinkSync(${JSON.stringify(f.initial)},file);}
 if(fault==='critical-file') {const file=${JSON.stringify(join(f.candidate, "dist/index.js"))};fs.chmodSync(file,0o644);fs.appendFileSync(file,'\\n');fs.chmodSync(file,0o444);}
 if(fault==='manifest-swap') {const directory=${JSON.stringify(f.candidate)},file=directory+'/deployment.json';fs.chmodSync(directory,0o755);fs.writeFileSync(file+'.swap',fs.readFileSync(file),{mode:0o444});fs.renameSync(file+'.swap',file);fs.chmodSync(directory,0o555);}
 if(fault==='root-swap') {const directory=${JSON.stringify(f.candidate)};fs.cpSync(directory,directory+'.swap',{recursive:true});fs.renameSync(directory,directory+'.original');fs.renameSync(directory+'.swap',directory);fs.chmodSync(directory,0o555);}
 event('fixture.static-proof-returned');
}
if(result.status===0&&args[0]==='migration-permit-revoke'&&fault==='after-revoke'&&!fs.existsSync(state+'/interrupted')) {
 fs.writeFileSync(state+'/interrupted','1');event('fixture.after-revoke');process.exit(73);
}
if(result.error)throw result.error;process.stdout.write(result.stdout);process.stderr.write(result.stderr);process.exit(result.status??1);
`);
  f.env.OPENCLAW_TEAM_RELEASE_LIB = proxy;
  return f;
}

for (const retained of [false, true]) test(`${retained ? "prepared recovery without permit" : "completed rehearsal"} keeps static audit work outside the lease and stops once`, t => {
  const f = fixture(t, retained), result = runOwner(f, ["--interrupt-after-drain"]);
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(existsSync(f.permit), false, result.stderr);
  assert.equal(readlinkSync(join(f.serving, "current")), f.initial);
  assert.deepEqual(JSON.parse(readFileSync(f.journal)).agentMigration.artifacts.preflight, f.originalPreflight);
  assert.deepEqual(readFileSync(f.preflightPath), f.preflightBytes);
  t.diagnostic(`LEASE_TIMING_RECEIPTS=${JSON.stringify(f.timing().filter(row => row.operation.endsWith('receipt')))}`);
  assert.match(events(f), /boundary\.stopped/, result.stderr + JSON.stringify(f.timing()));
  assert.equal(events(f).split("service.system.stop\n").length - 1, 1);
  assert.equal(f.timing().filter(row => row.operation === "release-tree-audit" && row.held).length, 0);
  const trace = f.timing(), requests = trace.filter(row => row.operation === "prepare-request");
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].request, requests[0].request);
  assert.ok(requests.every(row => row.armed === false));
  const offers = trace.filter(row => ["initial-offer", "renewal-offer"].includes(row.operation));
  assert.equal(offers.length, 2);
  assert.equal(offers[1].id, offers[0].id);
  assert.ok(offers[1].expiryUs > offers[0].expiryUs);
  const journal = JSON.parse(readFileSync(f.journal));
  assert.equal(journal.suspension.id, offers[1].id);
  assert.equal(journal.suspension.expiresAtMs, offers[1].expiresAtMs);
  const publications = trace.filter(row => row.operation === "proof:migration-transition");
  const handoff = trace.find(row => row.operation === "rpc:gateway.suspend.handoff:dispatch");
  assert.equal(publications.length, 2);
  assert.ok(publications[1].before > offers[1].before && publications[1].before <= handoff.before);
  assert.equal(trace.filter(row => row.operation === "interruption-receipt").length, 1);
  const stop = trace.find(row => row.operation === "native:systemctl:stop");
  assert.ok(stop.before < offers[1].expiryUs);
  t.diagnostic(`renewal and stop: ${JSON.stringify({ requests, offers, stop, remainingUs: offers[1].expiryUs - stop.before })}`);
  assert.doesNotMatch(events(f), /service\.system\.(start|restart)|doctor|permit\.published/);
  const recovered = runOwner(f, ["--recover"]);
  assert.equal(recovered.status, 1, recovered.stderr);
  assert.equal(events(f).split("service.system.stop\n").length - 1, 1, recovered.stderr);
  assert.equal(events(f).split("boundary.stopped\n").length - 1, 2, recovered.stderr);
});

for (const [fault, diagnostic] of [
  ["config", /stale candidate\/config binding/], ["journal", /journal bytes/],
  ["preflight", /preflight artifact changed/], ["controller", /another controller invocation/],
  ["pointer-swap", /prepared migration release facts changed/], ["critical-file", /prepared migration release facts changed/],
  ["manifest-swap", /prepared migration release facts changed/], ["root-swap", /prepared migration release facts changed/],
  ["reopened-lock", /inherited exclusive lock description/], ["instance", /cannot adopt a replacement predecessor/],
  ["custody", /stage=policy.*custody=held/], ["persistence", /stage=policy.*terminal-persistence/],
  ["generation", /generation changed/], ["expiry", /SUSPENSION_CHECK_FAILED stage=status/],
  ["renew-generation", /SUSPENSION_RENEWAL_UNCERTAIN stage=generation/],
  ["renew-instance", /synthetic handoff target or live lease mismatch/],
  ["renew-custody", /stage=policy.*custody=held/],
  ["renew-persistence", /stage=policy.*terminal-persistence/],
  ["ready-late", /stage=policy.*drainBudgetElapsed=0/],
  ["expired-before-renewal", /pre-arm renewal refuses an expired original suspension/],
]) test(`live migration refuses ${fault} drift without stop or preflight recapture`, t => {
  const f = fixture(t, true, fault), result = runOwner(f, ["--interrupt-after-drain"]);
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, diagnostic);
  assert.doesNotMatch(events(f), /service\.system\.(stop|start|restart)|boundary\.stopped/);
  assert.equal(readFileSync(join(f.state, "system"), "utf8"), "active");
  assert.equal(existsSync(f.permit), false);
  assert.deepEqual(JSON.parse(readFileSync(f.journal)).agentMigration.artifacts.preflight, f.originalPreflight);
  if (fault !== "preflight") assert.deepEqual(readFileSync(f.preflightPath), f.preflightBytes);
});

for (const fault of ["before-revoke", "after-revoke"]) test(`interruption ${fault} reuses prepared evidence and never remints a permit`, t => {
  const f = fixture(t, false, fault), result = runOwner(f, ["--interrupt-after-drain"]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(events(f), new RegExp(`fixture\\.${fault}`));
  assert.doesNotMatch(events(f), /service\.system\.stop/);
  assert.equal(existsSync(f.permit), fault === "before-revoke");
  const original = JSON.parse(readFileSync(f.journal)).agentMigration.artifacts;
  f.resetLeaseObservations();
  const recovered = runOwner(f, ["--interrupt-after-drain"]);
  assert.equal(recovered.status, 1, recovered.stderr);
  assert.match(events(f), /boundary\.stopped/, recovered.stderr);
  assert.equal(events(f).split("service.system.stop\n").length - 1, 1);
  assert.equal(existsSync(f.permit), false);
  assert.deepEqual(JSON.parse(readFileSync(f.journal)).agentMigration.artifacts, original);
  assert.deepEqual(readFileSync(f.preflightPath), f.preflightBytes);
  assert.doesNotMatch(events(f), /permit\.published/);
});

for (const fault of ["replacement", "uncertain", "uncertain-new", "malformed-renewal", "malformed-no-offer", "renew-no-advance"]) {
  test(`pre-arm ${fault} never becomes stop authority and retains exact cleanup outcome`, t => {
    const f = fixture(t, true, fault), result = runOwner(f, ["--interrupt-after-drain"]);
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /SUSPENSION_RENEWAL_UNCERTAIN/);
    assert.doesNotMatch(events(f), /service\.system\.(stop|start|restart)|handoff\.armed|permit\.published/);
    assert.equal(readFileSync(join(f.state, "system"), "utf8"), "active");
    assert.equal(existsSync(f.permit), false);
    const journal = JSON.parse(readFileSync(f.journal));
    assert.deepEqual(journal.agentMigration.artifacts.preflight, f.originalPreflight);
    assert.deepEqual(readFileSync(f.preflightPath), f.preflightBytes);
    const trace = f.timing(), offers = trace.filter(row => ["initial-offer", "renewal-offer"].includes(row.operation));
    const resume = trace.find(row => row.operation === "resume-request");
    const resumed = trace.find(row => row.operation === "resume-result");
    assert.equal(offers.length, 2);
    assert.equal(journal.suspension.id, offers[0].id);
    assert.equal(trace.filter(row => row.operation === "proof:migration-transition").length, 1);
    assert.equal(trace.filter(row => row.operation === "prepare-request").length, 2);
    if (fault === "replacement") {
      assert.notEqual(offers[1].id, offers[0].id);
      assert.match(result.stderr, /SUSPENSION_REPLACEMENT_OFFER/);
      assert.equal(resume.request.suspensionId, offers[1].id);
    } else assert.equal(resume.request.suspensionId, offers[0].id);
    if (fault === "uncertain-new") {
      assert.notEqual(offers[1].id, offers[0].id);
      assert.equal(resumed.result.reason, "suspension-mismatch");
      assert.match(result.stderr, /exact owned suspension resume was not acknowledged/);
      assert.equal(existsSync(join(f.state, "active-lease")), true);
    } else {
      assert.equal(resumed.result.resumed, true);
      assert.equal(existsSync(join(f.state, "active-lease")), false);
    }
  });
}

for (const fault of ["before-renew-cas", "after-renew-cas"]) test(`interruption ${fault} preserves original prepared recovery`, t => {
  const f = fixture(t, true, fault), result = runOwner(f, ["--interrupt-after-drain"]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(events(f), new RegExp(`fixture\\.${fault}`));
  assert.doesNotMatch(events(f), /service\.system\.stop|handoff\.armed|permit\.published/);
  const journal = JSON.parse(readFileSync(f.journal));
  assert.equal(journal.phase, "A_PREPARED");
  assert.equal(journal.agentMigration.phase, "prepared");
  assert.deepEqual(journal.agentMigration.artifacts.preflight, f.originalPreflight);
  assert.deepEqual(readFileSync(f.preflightPath), f.preflightBytes);
  assert.equal(existsSync(f.permit), false);
  assert.equal(existsSync(join(f.state, "active-lease")), false);
  const offers = f.timing().filter(row => ["initial-offer", "renewal-offer"].includes(row.operation));
  assert.equal(journal.suspension.expiresAtMs, offers[fault === "before-renew-cas" ? 0 : 1].expiresAtMs);
  f.resetLeaseObservations();
  const recovered = runOwner(f, ["--interrupt-after-drain"]);
  assert.equal(recovered.status, 1, recovered.stderr);
  assert.match(events(f), /boundary\.stopped/, recovered.stderr);
  assert.equal(events(f).split("service.system.stop\n").length - 1, 1);
  assert.equal(existsSync(f.permit), false);
  assert.deepEqual(JSON.parse(readFileSync(f.journal)).agentMigration.artifacts.preflight, f.originalPreflight);
  assert.doesNotMatch(events(f), /permit\.published/);
});
