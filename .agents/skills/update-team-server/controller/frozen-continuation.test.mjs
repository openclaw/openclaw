import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { events, makeReleaseFixture, runOwner } from "./worker-config-owner-fixture.mjs";

const target = "b".repeat(40), advancedMain = "c".repeat(40);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

function replaceSealedFile(pathname, body) {
  chmodSync(pathname, 0o644);
  writeFileSync(pathname, body);
  chmodSync(pathname, 0o444);
}

function fixture(t, fault = "", sourceState = 17, targetState = sourceState + 1, sourceAgent = 23, targetAgent = sourceAgent) {
  const f = makeReleaseFixture(t);
  const library = readFileSync(f.library, "utf8");
  f.library = join(f.root, "release-lib.mjs");
  writeFileSync(f.library, library.replace(
    'const suspensionContractPath = "/usr/local/lib/openclaw-team/gateway-suspension-contract.mjs";',
    `const suspensionContractPath = ${JSON.stringify(join(import.meta.dirname, "gateway-suspension-contract.mjs"))};`,
  ));
  if (process.env.FROZEN_CONTINUATION_TEST_OWNER) f.owner = process.env.FROZEN_CONTINUATION_TEST_OWNER;
  f.candidate = f.addRelease(target);
  for (const [release, state, agent] of [[f.initial, sourceState, sourceAgent], [f.candidate, targetState, targetAgent]]) {
    for (const name of ["package.json", "deployment.json"]) {
      const file = join(release, name), value = JSON.parse(readFileSync(file));
      if (name === "package.json") value.openclaw.schemaVersions = { state, agent };
      else value.schemaVersions = { state, agent };
      replaceSealedFile(file, JSON.stringify(value));
    }
  }
  const shared = new DatabaseSync(f.databasePath);
  shared.exec(`PRAGMA user_version=${sourceState}`); shared.close();
  const agent = new DatabaseSync(f.agentDatabasePath);
  agent.exec(`PRAGMA user_version=${sourceAgent}; UPDATE schema_meta SET schema_version=${sourceAgent}`); agent.close();
  f.manifest = join(f.candidate, "deployment.json");
  f.digest = hash(readFileSync(f.manifest));
  f.args = ["--continue-frozen-release", target, f.digest, f.sha, String(f.pid), f.start];
  f.before = {
    config: readFileSync(f.config), database: readFileSync(f.databasePath),
    agent: readFileSync(f.agentDatabasePath), manifest: readFileSync(f.manifest),
    guard: readFileSync(f.guard), permit: readFileSync(f.permit),
  };
  const executable = (file, body) => writeFileSync(file, "#!/usr/bin/env bash\nset -euo pipefail\n" + body + "\n", { mode: 0o755 });
  executable(f.commandPaths.systemctl, `
case "\${2:-}" in
  openclaw-hourly-update.timer|openclaw-nightly-update.timer)
    case "$1" in
      is-enabled) printf '%s\\n' ${quote(fault === "timer" ? "enabled" : "disabled")}; exit 0 ;;
      is-active) printf 'inactive\\n'; exit 3 ;;
    esac ;;
esac
exec ${quote(process.execPath)} ${quote(join(f.commands, "service-fixture.cjs"))} systemctl "$@"`);
  executable(join(f.commands, "git"), `
if [[ "$1" == -c && "$2" == gc.auto=0 && "$3" == -c && "$4" == maintenance.auto=false ]]; then shift 4; fi
[[ "$1" == -C && "$2" == ${quote(join(f.build, "mirror/mirror.git"))} ]] || exit 64
shift 2
case "$1" in
  remote) printf '%s\\n' https://github.com/openclaw/openclaw.git ;;
  fetch)
    printf 'git.fetch\\n' >>${quote(f.eventlog)}
    if [[ ${quote(fault)} == manifest-swap ]]; then
      ${quote(process.execPath)} -e ${quote(`const fs=require('node:fs');const file=${JSON.stringify(f.manifest)},directory=${JSON.stringify(f.candidate)};fs.chmodSync(directory,0o755);fs.writeFileSync(file+'.swap',fs.readFileSync(file),{mode:0o444});fs.renameSync(file+'.swap',file);fs.chmodSync(directory,0o555);`)}
    fi ;;
  rev-parse) printf '%s\\n' ${advancedMain} ;;
  merge-base)
    [[ "$2" == --is-ancestor ]] || exit 64
    [[ ${quote(fault)} != ancestry ]] || exit 1
    [[ "$3:$4" == ${target}:${advancedMain} || "$3:$4" == ${f.sha}:${target} ]] || exit 64 ;;
  *) exit 64 ;;
esac`);
  // This boundary keeps the real selector, release checks and journal writer.
  // Copied Doctor and its state-preservation semantics have their own native proof.
  const proxy = join(f.root, "continuation-proof.cjs");
  writeFileSync(proxy, `
const fs=require('node:fs'),cp=require('node:child_process');
const args=process.argv.slice(2),command=args[0],journal=${JSON.stringify(f.journal)};
const event=value=>fs.appendFileSync(${JSON.stringify(f.eventlog)},value+'\\n');
if(command==='migration-rehearse') {
  const record=JSON.parse(fs.readFileSync(journal));
  if(record.candidate.sha!==${JSON.stringify(target)}||record.predecessor.sha!==${JSON.stringify(f.sha)}||
    record.process.pid!==111||record.process.generation!=='1110'||record.process.instance!=='fixture-instance-111')
    throw Error('canonical journal lost the admitted selection or process');
  event('fixture.rehearsal-boundary');process.exit(73);
}
if(command==='migration-create'&&${JSON.stringify(fault)}==='before-journal') {event('fixture.before-journal');process.exit(73);}
// Non-consuming generation checks must leave a piped verification payload for its actual proof.
const result=cp.spawnSync(process.execPath,[${JSON.stringify(f.library)},...args],{stdio:['inherit','pipe','pipe'],encoding:'utf8',env:process.env});
if(result.error)throw result.error;
if(result.status===0&&((command==='compatibility'&&${JSON.stringify(fault)}==='manifest-at-compatibility')||
  (command==='journal-create'&&${JSON.stringify(fault)}==='manifest-after-journal'))) {
  const file=${JSON.stringify(f.manifest)},directory=${JSON.stringify(f.candidate)};
  fs.chmodSync(directory,0o755);fs.writeFileSync(file+'.swap',fs.readFileSync(file),{mode:0o444});
  fs.renameSync(file+'.swap',file);fs.chmodSync(directory,0o555);event('fixture.manifest-replaced');
}
if(command==='journal-create'&&result.status===0)event('fixture.ordinary-journal-created');
if(command==='session-preservation-witness'&&result.status===0&&${JSON.stringify(fault)}==='instance-before-preparation')
  fs.writeFileSync(${JSON.stringify(join(f.state, "frozen-replacement-instance"))},'1');
if(command==='migration-create'&&result.status===0) {
  event('fixture.journal-created');
  if(${JSON.stringify(fault)}==='after-journal')process.exit(73);
}
process.stdout.write(result.stdout);process.stderr.write(result.stderr);process.exit(result.status??1);
`);
  f.env.OPENCLAW_TEAM_RELEASE_LIB = proxy;
  if (fault === "instance" || fault === "instance-at-journal") {
    const cli = join(f.initial, "dist/index.js");
    const source = readFileSync(cli, "utf8");
    const original = 'const pid=Number(read("pid"));emit({pid,processInstanceId:"fixture-instance-"+pid});';
    assert.equal(source.split(original).length, 2);
    replaceSealedFile(cli, source.replace(original, `
const pid=Number(read("pid")),count=present("instance-reads")?Number(read("instance-reads")):0;
put("instance-reads",count+1);
emit({pid,processInstanceId:count>=${fault === "instance" ? 1 : 3}?'changed-with-identical-pid-and-ticks':'fixture-instance-'+pid});`));
  }
  if (fault === "instance-before-preparation") {
    const cli = join(f.initial, "dist/index.js"), source = readFileSync(cli, "utf8");
    const original = 'const pid=Number(read("pid"));emit({pid,processInstanceId:"fixture-instance-"+pid});';
    assert.equal(source.split(original).length, 2);
    replaceSealedFile(cli, source.replace(original,
      'const pid=Number(read("pid"));emit({pid,processInstanceId:present("frozen-replacement-instance")?"changed-with-identical-pid-and-ticks":"fixture-instance-"+pid});'));
  }
  return f;
}

function unchanged(f, result, pattern) {
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, pattern);
  assert.equal(existsSync(f.journal), false);
  assert.equal(readlinkSync(join(f.serving, "current")), f.initial);
  for (const [name, file] of [["config", f.config], ["database", f.databasePath], ["agent", f.agentDatabasePath], ["guard", f.guard], ["permit", f.permit]])
    assert.deepEqual(readFileSync(file), f.before[name], name);
  assert.doesNotMatch(events(f), /service\..*\.(stop|start|restart|daemon-reload)|fixture\.journal-created|gateway\.suspend/);
}

for (const [sourceState, targetState, sourceAgent, targetAgent, role, from, to] of [
  [17, 18, 23, 23, "state", 17, 18],
  [18, 19, 23, 23, "state", 18, 19],
  [19, 19, 23, 24, "agent", 23, 24],
  [19, 20, 24, 24, "state", 19, 20],
  [20, 20, 24, 25, "agent", 24, 25],
]) test(`continues the original ${role} ${to} sealed cut after main advances through one canonical migration journal`, t => {
  const f = fixture(t, "", sourceState, targetState, sourceAgent, targetAgent), result = runOwner(f, f.args);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(events(f).split("fixture.journal-created\n").length - 1, 1);
  assert.match(events(f), /git.fetch/);
  assert.match(events(f), /fixture.rehearsal-boundary/);
  const record = JSON.parse(readFileSync(f.journal));
  assert.equal(record.candidate.sha, target);
  assert.equal(record.predecessor.sha, f.sha);
  assert.deepEqual(record.process, { pid: f.pid, generation: f.start, instance: `fixture-instance-${f.pid}` });
  assert.equal(record.agentMigration.from, from);
  assert.equal(record.agentMigration.to, to);
  assert.ok(record.agentMigration.stage.startsWith(`${role}${from}-${to}-`));
  assert.deepEqual(readFileSync(f.manifest), f.before.manifest);
  const journal = readFileSync(f.journal), beforeEvents = events(f);
  const duplicate = runOwner(f, f.args);
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /pending journal/);
  assert.deepEqual(readFileSync(f.journal), journal);
  assert.equal(events(f), beforeEvents);
});

test("continues the original same-schema sealed cut through ordinary activation after main advances", t => {
  const f = fixture(t, "", 19, 19);
  // Full activation now checks ownership at every verification step through native fixture subprocesses.
  f.ownerTimeoutMs = 180_000;
  const result = runOwner(f, f.args);
  assert.equal(result.error, undefined, `${result.stdout}\n${result.stderr}\n${events(f)}`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`SUCCESS sha=${target} action=deploy previous=${f.sha} APPROVAL_DELTA=0`));
  assert.equal(readlinkSync(join(f.serving, "current")), f.candidate);
  assert.equal(existsSync(f.journal), false);
  const log = events(f);
  assert.equal(log.split("fixture.ordinary-journal-created\n").length - 1, 1);
  assert.equal(log.split("service.system.stop\n").length - 1, 1);
  assert.equal(log.split("service.system.start\n").length - 1, 1);
  assert.doesNotMatch(log, /fixture\.rehearsal-boundary|fixture\.journal-created|gateway doctor|service\.system\.restart/);
  for (const [name, file] of [["config", f.config], ["database", f.databasePath], ["agent", f.agentDatabasePath], ["manifest", f.manifest]])
    assert.deepEqual(readFileSync(file), f.before[name], name);
});

for (const fault of ["instance-before-preparation", "manifest-at-compatibility", "manifest-after-journal"]) test(`same-schema continuation refuses late ${fault} drift without stopping`, t => {
  const f = fixture(t, fault, 19, 19), result = runOwner(f, f.args);
  assert.ifError(result.error);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, fault === "instance-before-preparation" ? /process instance changed/ : /frozen release identity changed/);
  assert.equal(existsSync(f.journal), fault === "manifest-after-journal");
  assert.equal(readlinkSync(join(f.serving, "current")), f.initial);
  const log = events(f);
  assert.doesNotMatch(log, /service\..*\.(stop|start|restart)/);
  assert.equal(existsSync(join(f.state, "active-lease")), false);
  if (fault !== "instance-before-preparation") assert.match(log, /gateway\.suspend\.resume/);
  for (const [name, file] of [["config", f.config], ["database", f.databasePath], ["agent", f.agentDatabasePath]])
    assert.deepEqual(readFileSync(file), f.before[name], name);
  if (fault === "manifest-after-journal") {
    const retained = readFileSync(f.journal);
    const duplicate = runOwner(f, f.args);
    assert.notEqual(duplicate.status, 0);
    assert.match(duplicate.stderr, /pending journal/);
    assert.deepEqual(readFileSync(f.journal), retained);
    const recovered = runOwner(f, ["--recover"]);
    assert.notEqual(recovered.status, 0);
    assert.match(recovered.stderr, /journal suspension has not expired/);
    assert.deepEqual(readFileSync(f.journal), retained);
    assert.equal(readlinkSync(join(f.serving, "current")), f.initial);
    assert.doesNotMatch(events(f), /service\..*\.(stop|start|restart)/);
  }
});

for (const fault of ["timer", "ancestry", "instance", "manifest-swap"]) test(`refuses ${fault} drift without a lifecycle mutation`, t => {
  const f = fixture(t, fault);
  unchanged(f, runOwner(f, f.args), fault === "timer" ? /disabled inactive/ : fault === "ancestry" ? /official main history/ : fault === "manifest-swap" ? /frozen release identity changed/ : /process instance changed/);
});

test("does not recapture a replacement process instance while constructing the journal", t => {
  const f = fixture(t, "instance-at-journal"), result = runOwner(f, f.args);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /process instance changed/);
  assert.equal(existsSync(f.journal), false);
  assert.doesNotMatch(events(f), /service\..*\.(stop|start|restart)\n|fixture\.journal-created/);
  assert.deepEqual(readFileSync(f.databasePath), f.before.database);
});

test("reports a busy canonical lock as refusal, never successful SKIP", t => {
  const f = fixture(t);
  writeFileSync(f.commandPaths.flock, "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });
  const result = runOwner(f, f.args);
  unchanged(f, result, /canonical deployment lock is busy/);
  assert.doesNotMatch(result.stdout, /SKIP/);
});

for (const [label, mutate, pattern] of [
  ["wrong manifest", f => { f.args[2] = "0".repeat(64); }, /manifest|digest/],
  ["wrong predecessor", f => { f.args[3] = "d".repeat(40); }, /predecessor changed/],
  ["reused PID", f => { f.args[5] = "1111"; }, /generation changed/],
  ["changed original freeze", f => {
    const value = JSON.parse(readFileSync(f.manifest)); value.frozenOriginMain = advancedMain;
    replaceSealedFile(f.manifest, JSON.stringify(value)); f.args[2] = hash(readFileSync(f.manifest));
  }, /frozen|manifest/],
]) test(`refuses ${label} before mutation`, t => {
  const f = fixture(t); mutate(f); unchanged(f, runOwner(f, f.args), pattern);
});

for (const additional of [
  ["--sha", target], ["--recover"], ["--prepare-release", target], ["--migrate"],
  ["--cleanup"], ["--capture-startup-profile"], ["--arm-steady-profile"], ["--skip-migration-rehearsal"],
]) test(`refuses mixed ${additional[0]} intent`, t => {
  const f = fixture(t);
  unchanged(f, runOwner(f, [...f.args, ...additional]), /requires|cannot|only valid|selected|without another action/);
});

test("ordinary --sha still rejects the historical frozen cut", t => {
  const f = fixture(t);
  unchanged(f, runOwner(f, ["--sha", target]), /not the exact frozen official/);
});

test("preparation validates the sealed cut without activation and no-journal recovery stays inert", t => {
  const f = fixture(t);
  const prepared = runOwner(f, ["--prepare-release", target]);
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.match(prepared.stdout, /restart=0 activation=0/);
  const recovered = runOwner(f, ["--recover"]);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(existsSync(f.journal), false);
  assert.doesNotMatch(events(f), /service\..*\.(stop|start|restart|daemon-reload)|fixture\.journal-created/);
  assert.deepEqual(readFileSync(f.manifest), f.before.manifest);
});

for (const fault of ["before-journal", "after-journal"]) test(`interruption ${fault} preserves the exact cut and uses existing recovery`, t => {
  const f = fixture(t, fault), interrupted = runOwner(f, f.args);
  assert.equal(interrupted.status, 1, interrupted.stderr);
  assert.equal(existsSync(f.journal), fault === "after-journal");
  assert.equal(events(f).split(`fixture.${fault === "after-journal" ? "journal-created" : "before-journal"}\n`).length - 1, 1);
  assert.doesNotMatch(events(f), /fixture\.rehearsal-boundary/);
  const journal = existsSync(f.journal) ? readFileSync(f.journal) : undefined;
  const recovered = runOwner(f, ["--recover"]);
  assert.equal(recovered.status, fault === "after-journal" ? 1 : 0, recovered.stderr);
  assert.equal(events(f).split("fixture.rehearsal-boundary\n").length - 1, fault === "after-journal" ? 1 : 0);
  if (journal) assert.deepEqual(readFileSync(f.journal), journal);
  assert.deepEqual(readFileSync(f.manifest), f.before.manifest);
  assert.doesNotMatch(events(f), /service\..*\.(stop|start|restart)\n/);
});

test("unacknowledged frozen admission cannot clean profiling state or retire an uncertain journal", t => {
  const f = fixture(t), source = readFileSync(f.owner, "utf8");
  const start = source.indexOf("on_exit() {"), end = source.indexOf("\n}\n", start) + 3;
  assert.ok(start >= 0 && end > start);
  for (const retainedJournal of [false, true]) {
    if (retainedJournal) writeFileSync(f.journal, "uncertain original journal\n");
    const script = `set -u
mode=deploy; abandon_rehearsal_sha=; frozen_target_sha=${target}; migration_evidence=; held_suspension=; rollback_armed=0
profile_finish(){ printf 'unexpected-cleanup'; }
profile_close(){ printf 'unexpected-cleanup'; }
profile_maintenance(){ printf 'unexpected-cleanup'; }
${source.slice(start, end)}
false
on_exit
`;
    const result = spawnSync(f.realCommands.bash, ["-c", script], { encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(existsSync(f.journal), retainedJournal);
    if (retainedJournal) assert.equal(readFileSync(f.journal, "utf8"), "uncertain original journal\n");
  }
});
