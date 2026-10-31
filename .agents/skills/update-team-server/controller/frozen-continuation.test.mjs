import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
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

function nativeReceipt(f) {
  const directory = join(f.runtime, ".openclaw-update");
  const paths = readdirSync(directory).map(name => join(directory, name, "native.receipt.json")).filter(existsSync);
  assert.equal(paths.length, 1);
  return { backupRoot: paths[0].slice(0, -".receipt.json".length), receipt: JSON.parse(readFileSync(paths[0])) };
}

function fixture(t, fault = "", sourceState = 17, targetState = sourceState, sourceAgent = 23, targetAgent = sourceAgent, offlineDoctor = false) {
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
if [[ ${quote(fault)} == activation-failed && "$1" == start && "$2" == openclaw-gateway.service && ! -e ${quote(join(f.state, "candidate-start-failed"))} ]]; then
  [[ -f ${quote(f.permit)} ]] || { printf 'candidate start lacked its published permit\\n' >&2; exit 73; }
  : >${quote(join(f.state, "candidate-start-failed"))}
  printf 'service.system.start\\nfixture.candidate-start-failed\\n' >>${quote(f.eventlog)}
  printf 'synthetic candidate start failed after migration\\n' >&2
  exit 73
fi
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
  // The controller owns ordering and recovery; native migration/backup correctness
  // has separate update-command proof. This CLI double requires stopped writers
  // and produces the same durable receipt consumed by the real controller.
  const candidateCli = join(f.candidate, "dist/index.js");
  const updateCli = `
if(process.argv[2]==='update') {
  const fs=require('node:fs'),path=require('node:path'),{DatabaseSync}=require('node:sqlite');
  const action=process.argv[3],root=process.argv[5],state=${JSON.stringify(f.state)};
  const read=name=>fs.readFileSync(path.join(state,name),'utf8').trim();
  const event=value=>fs.appendFileSync(${JSON.stringify(f.eventlog)},value+'\\n');
  const reject=message=>{process.stderr.write(message+'\\n');process.exit(73);};
  if(process.argv.length!==6||process.argv[4]!=='--backup-root'||!['migrate','restore','finish'].includes(action))
    reject('unexpected native update invocation');
  if(path.basename(root)!=='native'||path.dirname(path.dirname(root))!==${JSON.stringify(join(f.runtime, ".openclaw-update"))}||
    !new RegExp(${JSON.stringify(`^update-${target}-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$`)}).test(path.basename(path.dirname(root))))
    reject('native update lost its runtime-owned attempt backup root');
  if(action==='finish') {
    if(fs.existsSync(${JSON.stringify(f.journal)})||read('system')!=='active'||
      !fs.existsSync(${JSON.stringify(f.permit)})) reject('native update cleanup preceded accepted activation');
    const completed=JSON.parse(fs.readFileSync(root+'.receipt.json'));
    if(!['migrated','finished'].includes(completed.status)) reject('native update cleanup lacks an accepted receipt');
    completed.status='finished';fs.writeFileSync(root+'.receipt.json',JSON.stringify(completed));
    event('native.update.finish');
    fs.rmSync(root+'.databases',{recursive:true});
    process.exit(0);
  }
  if(read('system')!=='inactive'||read('pid')!=='0'||read('listener-pid')!=='0')
    reject('native update requires stopped writers');
  if(fs.existsSync(${JSON.stringify(f.permit)})||read('guard-loaded')!=='1')
    reject('native update requires its installed start fence');
  if(process.env.OPENCLAW_CONFIG_PATH!==${JSON.stringify(f.config)}||
    process.env.OPENCLAW_STATE_DIR!==${JSON.stringify(f.root)}||process.env.OPENCLAW_SUPERVISOR_MODE!=='external')
    reject('native update lost its admitted environment');
  if(${offlineDoctor}&&process.env.OPENCLAW_DOCTOR_SQLITE_NOCOW_REPAIR!=='1')
    reject('native update lost its explicit offline Doctor repair intent');
  const record=JSON.parse(fs.readFileSync(${JSON.stringify(f.journal)}));
  if(record.nativeUpdate?.backupRoot!==root||record.candidate.sha!==${JSON.stringify(target)}||
    record.predecessor.sha!==${JSON.stringify(f.sha)}||record.agentMigration!==undefined)
    reject('native update lost its ordinary activation journal');
  event('native.update.'+action);
  const files=[${JSON.stringify(f.config)},${JSON.stringify(f.databasePath)},${JSON.stringify(f.agentDatabasePath)}];
  const identity=file=>{const info=fs.statSync(file);return {dev:info.dev,ino:info.ino};};
  const receipt=status=>fs.writeFileSync(root+'.receipt.json',JSON.stringify({schemaVersion:1,status,
    configPath:files[0],stateDir:${JSON.stringify(f.root)},databases:files.slice(1),
    databaseIdentities:Object.fromEntries(files.slice(1).map(file=>[file,identity(file)])),
    configIdentity:{path:files[0],...identity(files[0])}}),{mode:0o600});
  if(action==='migrate') {
    if(fs.realpathSync(${JSON.stringify(join(f.serving, "current"))})!==${JSON.stringify(f.initial)})
      reject('candidate selected before migration');
    fs.mkdirSync(root+'.databases',{mode:0o700});
    for(let i=0;i<files.length;i++)fs.copyFileSync(files[i],path.join(root+'.databases',String(i)));
    receipt('backed-up');
    for(const [file,version] of [[files[1],${targetState}],[files[2],${targetAgent}]]) {
      const db=new DatabaseSync(file);
      try {db.exec('PRAGMA user_version='+version);if(file===files[2])db.exec('UPDATE schema_meta SET schema_version='+version);}
      finally {db.close();}
    }
    if(['migration-failed','restore-failed'].includes(${JSON.stringify(fault)})) {
      receipt('failed');reject('synthetic native migration failed after backup');
    }
    receipt('migrated');
  } else {
    if(${JSON.stringify(fault)}==='restore-failed')reject('synthetic native restore failed');
    for(let i=0;i<files.length;i++) {
      const replacement=files[i]+'.restored';
      fs.copyFileSync(path.join(root+'.databases',String(i)),replacement);fs.renameSync(replacement,files[i]);
    }
    receipt('restored');
  }
  process.exit(0);
}
`;
  replaceSealedFile(candidateCli, updateCli + readFileSync(candidateCli, "utf8"));
  // Retain the real selector, release checks, journal and acceptance owner.
  const proxy = join(f.root, "continuation-proof.cjs");
  writeFileSync(proxy, `
const fs=require('node:fs'),cp=require('node:child_process');
const args=process.argv.slice(2),command=args[0],journal=${JSON.stringify(f.journal)};
const event=value=>fs.appendFileSync(${JSON.stringify(f.eventlog)},value+'\\n');
if(command==='journal-create'&&${JSON.stringify(fault)}==='before-journal') {event('fixture.before-journal');process.exit(73);}
// Non-consuming generation checks must leave a piped verification payload for its actual proof.
const result=cp.spawnSync(process.execPath,[${JSON.stringify(f.library)},...args],{stdio:['inherit','pipe','pipe'],encoding:'utf8',env:process.env});
if(result.error)throw result.error;
if(result.status===0&&((command==='compatibility'&&${JSON.stringify(fault)}==='manifest-at-compatibility')||
  (command==='journal-create'&&${JSON.stringify(fault)}==='manifest-after-journal'))) {
  const file=${JSON.stringify(f.manifest)},directory=${JSON.stringify(f.candidate)};
  fs.chmodSync(directory,0o755);fs.writeFileSync(file+'.swap',fs.readFileSync(file),{mode:0o444});
  fs.renameSync(file+'.swap',file);fs.chmodSync(directory,0o555);event('fixture.manifest-replaced');
}
if(command==='journal-create'&&result.status===0) {
  const record=JSON.parse(fs.readFileSync(journal));
  if(record.candidate.sha!==${JSON.stringify(target)}||record.predecessor.sha!==${JSON.stringify(f.sha)}||
    record.process.pid!==111||record.process.generation!=='1110'||record.process.instance!=='fixture-instance-111')
    throw Error('canonical journal lost the admitted selection or process');
  event('fixture.ordinary-journal-created');
  if(${JSON.stringify(fault)}==='after-journal')process.exit(73);
}
if(command==='session-preservation-witness'&&result.status===0&&${JSON.stringify(fault)}==='instance-before-preparation')
  fs.writeFileSync(${JSON.stringify(join(f.state, "frozen-replacement-instance"))},'1');
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
  assert.doesNotMatch(events(f), /service\..*\.(stop|start|restart|daemon-reload)|fixture\.ordinary-journal-created|gateway\.suspend/);
}

for (const [sourceState, targetState, sourceAgent, targetAgent, offlineDoctor = false] of [
  [20, 20, 25, 26],
  [20, 21, 25, 27],
  [20, 20, 25, 25, true],
]) test(`continues the sealed cut through native update (${sourceState}/${sourceAgent} → ${targetState}/${targetAgent}${offlineDoctor ? "; offline Doctor repair" : ""})`, t => {
  const f = fixture(t, "", sourceState, targetState, sourceAgent, targetAgent, offlineDoctor);
  if (offlineDoctor) f.args.push("--offline-doctor-repair", "--interrupt-after-drain");
  // An earlier rolled-back transaction is settled; this deployment keeps only its own root.
  const earlier = join(f.runtime, ".openclaw-update", `update-${f.sha}-${randomUUID()}`);
  mkdirSync(join(earlier, "native.databases"), { recursive: true });
  writeFileSync(join(earlier, "native.receipt.json"), JSON.stringify({ schemaVersion: 1, status: "restored" }));
  const result = runOwner(f, f.args);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`SUCCESS sha=${target} action=deploy previous=${f.sha} APPROVAL_DELTA=0`));
  assert.equal(readlinkSync(join(f.serving, "current")), f.candidate);
  assert.equal(existsSync(f.journal), false);
  const log = events(f);
  assert.equal(log.split("fixture.ordinary-journal-created\n").length - 1, 1);
  assert.match(log, /git.fetch/);
  assert.match(log, /gateway\.suspend\.prepare[\s\S]*service\.system\.stop[\s\S]*native\.update\.migrate[\s\S]*service\.system\.start[\s\S]*probe\.readyz[\s\S]*gateway gateway call sessions\.list[\s\S]*native\.update\.finish/);
  assert.equal(existsSync(f.permit), true);
  const { backupRoot, receipt } = nativeReceipt(f);
  assert.equal(receipt.status, "finished");
  assert.equal(existsSync(`${backupRoot}.databases`), false);
  assert.doesNotMatch(log, /native\.update\.restore|service\.system\.restart/);
  const shared = new DatabaseSync(f.databasePath), agent = new DatabaseSync(f.agentDatabasePath);
  try {
    assert.equal(shared.prepare("PRAGMA user_version").get().user_version, targetState);
    assert.equal(agent.prepare("PRAGMA user_version").get().user_version, targetAgent);
    assert.equal(agent.prepare("SELECT count(*) AS count FROM session_nodes").get().count, 1);
  } finally { shared.close(); agent.close(); }
  assert.deepEqual(readFileSync(f.config), f.before.config);
  assert.deepEqual(readFileSync(f.manifest), f.before.manifest);
});

for (const fault of ["migration-failed", "activation-failed", "restore-failed"]) test(`native update ${fault} preserves recovery ownership`, t => {
  const f = fixture(t, fault, 20, 20, 25, 26), result = runOwner(f, f.args);
  assert.ifError(result.error);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, fault === "activation-failed"
    ? /synthetic candidate start failed after migration/
    : /synthetic native migration failed after backup/);
  assert.equal(readlinkSync(join(f.serving, "current")), f.initial);
  const log = events(f);
  assert.match(log, /service\.system\.stop[\s\S]*native\.update\.migrate[\s\S]*native\.update\.restore/);
  if (fault === "activation-failed") {
    assert.match(log, /native\.update\.migrate[\s\S]*fixture\.candidate-start-failed[\s\S]*native\.update\.restore/);
    assert.equal(log.split("service.system.start\n").length - 1, 1);
  } else {
    assert.doesNotMatch(log, /service\.system\.start\n/);
  }
  assert.doesNotMatch(log, /native\.update\.finish/);
  const { backupRoot, receipt } = nativeReceipt(f);
  assert.equal(existsSync(`${backupRoot}.databases`), true);
  assert.equal(receipt.status,
    fault === "restore-failed" ? "failed" : "restored");
  if (fault !== "restore-failed") {
    assert.match(log, /native\.update\.restore[\s\S]*service\.system\.restart[\s\S]*probe\.readyz[\s\S]*gateway gateway call sessions\.list/);
    assert.match(result.stderr, /ROLLED_BACK/);
    assert.equal(existsSync(f.journal), false);
    assert.equal(existsSync(f.permit), true);
    for (const [name, file] of [["config", f.config], ["database", f.databasePath], ["agent", f.agentDatabasePath]])
      assert.deepEqual(readFileSync(file), f.before[name], name);
  } else {
    assert.match(result.stderr, /native update restoration failed/);
    assert.equal(existsSync(f.permit), false);
    assert.doesNotMatch(log, /service\.system\.restart/);
    assert.equal(readFileSync(join(f.state, "system"), "utf8"), "inactive");
    assert.equal(JSON.parse(readFileSync(f.journal)).phase, "ROLLBACK_FAILED");
  }
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
  assert.doesNotMatch(log, /native\.update\.|gateway doctor|service\.system\.restart/);
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
  assert.doesNotMatch(events(f), /service\..*\.(stop|start|restart)\n|fixture\.ordinary-journal-created/);
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
  ["--cleanup"], ["--capture-startup-profile"], ["--arm-steady-profile"],
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
  assert.doesNotMatch(events(f), /service\..*\.(stop|start|restart|daemon-reload)|fixture\.ordinary-journal-created/);
  assert.deepEqual(readFileSync(f.manifest), f.before.manifest);
});

for (const fault of ["before-journal", "after-journal"]) test(`interruption ${fault} preserves the exact cut and uses existing recovery`, t => {
  const f = fixture(t, fault), interrupted = runOwner(f, f.args);
  assert.equal(interrupted.status, 1, interrupted.stderr);
  assert.equal(existsSync(f.journal), fault === "after-journal");
  assert.equal(events(f).split(`fixture.${fault === "after-journal" ? "ordinary-journal-created" : "before-journal"}\n`).length - 1, 1);
  assert.doesNotMatch(events(f), /native\.update\./);
  const journal = existsSync(f.journal) ? readFileSync(f.journal) : undefined;
  const recovered = runOwner(f, ["--recover"]);
  assert.equal(recovered.status, fault === "after-journal" ? 1 : 0, recovered.stderr);
  assert.doesNotMatch(events(f), /native\.update\./);
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
mode=deploy; frozen_target_sha=${target}; held_suspension=; rollback_armed=0
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
