import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, chownSync, lchownSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { makeReleaseFixture } from "./worker-config-owner-fixture.mjs";

const localSqlite = { skip: process.platform !== "linux" ? "Linux process inventory required" : false };
const linux = { skip: process.platform !== "linux" || process.getuid() !== 0 ? "isolated Linux namespace root required" : false };
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function fixture(t, actual = 17, agentVersion = 19, edge = "state") {
  const f = makeReleaseFixture(t), sha = "b".repeat(40), candidate = f.addRelease(sha);
  const authorityEdge = edge === "publication" || edge === "channel";
  const coldEdge = edge === "writer-validation" || authorityEdge || edge === "snapshots" || edge === "cold" || edge === "validation" || edge === "fts" || edge === "storage";
  const fromAgent = edge === "writer-validation" ? 24 : authorityEdge || edge === "snapshots" ? 23 : edge === "storage" ? 22 : edge === "fts" ? 21 : edge === "validation" ? 20 : 19;
  const toAgent = authorityEdge ? 23 : coldEdge ? fromAgent + 1 : 19;
  const fromState = edge === "writer-validation" ? 20 : edge === "snapshots" ? 19 : edge === "channel" ? 18 : coldEdge ? 17 : 16;
  const toState = edge === "writer-validation" ? 20 : authorityEdge ? fromState + 1 : edge === "snapshots" ? 19 : 17;
  const library = process.env.FORWARD_TEST_LIBRARY ?? join(import.meta.dirname, "release-lib.mjs");
  const run = (command, args = [], input, preload) => spawnSync(process.execPath,
    ["--no-warnings", ...(preload ? ["--import", preload] : []), library, command, ...args.map(String)],
    { encoding: "utf8", env: f.env, cwd: f.root, input, timeout: 30000 });
  const succeeds = result => { assert.ifError(result.error); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  const proof = (command, args = [], input) => succeeds(run(command, args, input));
  const stateRoot = join(f.runtime, ".openclaw"), config = join(stateRoot, "openclaw.json"), shared = join(stateRoot, "state/openclaw.sqlite"), agent = join(stateRoot, "agents/controller-test-agent/agent/openclaw-agent.sqlite");
  const agents = (fromAgent >= 20 ? ["controller-test-agent", "helper"] : ["controller-test-agent"]).map(agentId => ({
    agentId, path: join(stateRoot, "agents", agentId, "agent/openclaw-agent.sqlite"),
  }));
  chmodSync(f.root, 0o755); chmodSync(f.runtime, 0o755);
  for (const p of [stateRoot, dirname(shared), ...agents.map(store => dirname(store.path)), join(stateRoot, "workspace"), join(stateRoot, "secrets")]) mkdirSync(p, { recursive: true, mode: 0o700 });
  writeFileSync(config, JSON.stringify({ agents: { defaults: { workspace: join(stateRoot, "workspace") }, entries: Object.fromEntries(agents.map(store => [store.agentId, {}])) } }), { mode: 0o600 });
  for (const p of ["secrets/github.env", "secrets/model-backups.env", "team-worker-artifact.env"]) writeFileSync(join(stateRoot, p), "# synthetic fixture\n", { mode: 0o600 });
  const sharedDb = new DatabaseSync(shared);
  sharedDb.exec(`PRAGMA user_version=${actual}; CREATE TABLE schema_meta(meta_key TEXT,role TEXT,schema_version INTEGER,agent_id TEXT,created_at INTEGER); INSERT INTO schema_meta VALUES('primary','global',${actual},NULL,1);
    CREATE TABLE agent_databases(agent_id TEXT,path TEXT,schema_version INTEGER,last_seen_at INTEGER,size_bytes INTEGER);
    CREATE TABLE plugin_state_entries(plugin_id TEXT,namespace TEXT,entry_key TEXT,value_json TEXT); CREATE TABLE config_machine_state(state_key TEXT,value_json TEXT);
    CREATE TABLE skill_workshop_proposals(proposal_id TEXT PRIMARY KEY); INSERT INTO skill_workshop_proposals VALUES('retained-proposal');
    CREATE TABLE retained_data(value TEXT); INSERT INTO retained_data VALUES('latest current data');`);
  for (const { agentId } of agents)
    sharedDb.prepare("INSERT INTO agent_databases VALUES(?,?,?,1,NULL)").run(agentId, `agents/${agentId}/agent/openclaw-agent.sqlite`, agentVersion);
  sharedDb.close();
  for (const { agentId, path } of agents) {
    const agentDb = new DatabaseSync(path);
    agentDb.exec(`PRAGMA user_version=${agentVersion}; CREATE TABLE schema_meta(meta_key TEXT,role TEXT,schema_version INTEGER,agent_id TEXT,created_at INTEGER); INSERT INTO schema_meta VALUES('primary','agent',${agentVersion},'${agentId}',1);
      CREATE TABLE session_nodes(session_key TEXT,current_session_id TEXT); INSERT INTO session_nodes VALUES('agent:${agentId}:parent','retained-session');
      CREATE TABLE session_windows(session_key TEXT,session_id TEXT PRIMARY KEY); INSERT INTO session_windows VALUES('agent:${agentId}:parent','retained-session');
      CREATE TABLE transcript_rewrite_watermarks(session_id TEXT,generation TEXT); INSERT INTO transcript_rewrite_watermarks VALUES('retained-session','generation-one');
      CREATE TABLE session_participants(session_key TEXT,identity_namespace TEXT,actor_id TEXT,contribution_count INTEGER,first_prompted_at INTEGER,last_prompted_at INTEGER);`);
    if (coldEdge) {
      agentDb.exec(`CREATE TABLE transcript_events(session_id TEXT,seq INTEGER,event_json TEXT,created_at INTEGER,PRIMARY KEY(session_id,seq));
        CREATE TABLE session_transcript_archives(session_id TEXT,generation TEXT,archive_blob BLOB,archive_sha256 TEXT,encoding TEXT);`);
      agentDb.prepare("INSERT INTO transcript_events VALUES(?,?,?,?)").run("retained-session", 1, '{ "text": "keep Unicode 🦞 and whitespace" }', 1);
      const archive = Buffer.from('exact reset archive bytes\n');
      agentDb.prepare("INSERT INTO session_transcript_archives VALUES(?,?,?,?,?)").run("reset-session", "reset-generation", archive, hash(archive), "identity");
      if (agentVersion >= 20) agentDb.exec(readFileSync(new URL("./agent20-cold-schema.fixture.sql", import.meta.url), "utf8"));
    }
    agentDb.close();
  }
  const own = p => { chownSync(p, 1000, 1000); if (stat(p).isDirectory()) for (const n of readdirSync(p)) own(join(p,n)); else chmodSync(p, 0o600); };
  own(stateRoot);
  const releases = [];
  for (const [p, id, version, agentSchema] of [
    [f.initial, f.sha, fromState, fromAgent], [candidate, sha, toState, toAgent],
  ]) {
    chmodSync(p, 0o755); chmodSync(join(p, "package.json"), 0o644);
    writeFileSync(join(p, "package.json"), JSON.stringify({ version: "2026.9.3", openclaw: { schemaVersions: { state: version, agent: agentSchema } } }));
    if (coldEdge && p === candidate) {
      mkdirSync(join(p, "src/state"), { recursive: true });
      writeFileSync(join(p, "src/state/openclaw-agent-schema.sql"), readFileSync(new URL("./agent20-cold-schema.fixture.sql", import.meta.url)));
    }
    // The fixtures contain no vector tables; native SQLite backup/integrity remains real.
    chmodSync(join(p, "node_modules"), 0o755); mkdirSync(join(p, "node_modules/sqlite-vec"));
    writeFileSync(join(p, "node_modules/sqlite-vec/index.js"), "exports.load=db=>db.function('vec_version',()=> 'fixture');");
    proof("manifest", [p,id,process.getuid(),id]); proof("seal-tree", [p]);
    releases.push(JSON.parse(proof("validate-release",[p,id,process.getuid(),"sealed"])));
  }
  const base = { version:1, topology:"system", predecessor:releases[0], candidate:releases[1],
    process:{pid:111,generation:"1110",instance:"fixture-instance-111"}, suspension:null,
    services:{system:{unitFileState:"enabled",activeState:"active"},user:{unitFileState:"disabled",activeState:"inactive"}},
    protectedPaths:JSON.parse(proof("fingerprint",[config,shared])),
    pointerTopology:{current:{present:true,sha:f.sha},previous:{present:false,sha:null}} };
  let evidence=JSON.parse(proof("migration-create",[f.serving,"@stdin"],JSON.stringify(base)));
  const stage=join(f.serving,"journal",evidence.record.agentMigration.stage);
  // Model the successfully completed warm phase. Cold admission must keep this original evidence.
  const warm=join(stage,`warm-source-${fromState}.fixture`);writeFileSync(warm,"retained original warm source evidence",{mode:0o600});
  const preflight=join(stage,`preflight-${randomUUID()}.json`);writeFileSync(preflight,JSON.stringify({version:1,completeClosure:true,dataReady:true,candidate:sha,
    schemaProfile:{from:base.predecessor.schemaVersions,to:base.candidate.schemaVersions}}),{mode:0o600});
  const st=stat(preflight),record=evidence.record;record.phase="C_CURRENT_SELECTED";record.suspension={id:randomUUID(),expiresAtMs:Date.now()+60000,terminalPolicy:"preserve",status:"ready"};record.agentMigration.phase="prepared";
  record.agentMigration.artifacts.preflight={name:preflight.split('/').at(-1),device:st.dev,inode:st.ino,sha256:hash(readFileSync(preflight))};writeFileSync(f.journal,JSON.stringify(record),{mode:0o600});
  rmSync(join(f.serving,"current"));symlinkSync(candidate,join(f.serving,"current"));symlinkSync(f.initial,join(f.serving,"previous"));rmSync(f.permit);rmSync(f.env.OPENCLAW_TEAM_PROC_ROOT,{recursive:true});mkdirSync(f.env.OPENCLAW_TEAM_PROC_ROOT);
  evidence=JSON.parse(proof("migration-load",[f.journal,f.serving]));
  const load=()=>JSON.parse(proof("migration-load",[f.journal,f.serving]));
  const cold=(preload)=>run("migration-cold-backup",[f.journal,f.serving,JSON.stringify(load()),config,shared,f.env.OPENCLAW_TEAM_PROC_ROOT],undefined,preload);
  const artifact=kind=>{const e=load();return JSON.parse(readFileSync(join(stage,e.record.agentMigration.artifacts[kind].name)));};
  return {...f, library,candidate,config,shared,agent,agents,fromState,toState,toAgent,stage,warm,run,proof,cold,load,artifact,succeeds};
}
import { statSync as stat } from "node:fs";

const namespace = {
  skip: linux.skip || (!existsSync("/usr/bin/bwrap") ? "isolated Linux root with bubblewrap required" : false),
};
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const fileBinding = path => ({ path, device: stat(path).dev, inode: stat(path).ino,
  size: stat(path).size, sha256: hash(readFileSync(path)) });

function warmRehearsalFixture(t, phase = "prepared") {
  const f = fixture(t, 17, 23, "publication");
  assert.ok(f.realCommands.flock, "refresh proof requires a real inherited flock");
  const config = { ...JSON.parse(f.originalConfigBytes), agents: JSON.parse(readFileSync(f.config)).agents };
  config.agents.entries["controller-test-agent"].model = "fixture/exact-model";
  writeFileSync(f.config, JSON.stringify(config));
  const entry = join(f.candidate, "dist/index.js");
  chmodSync(entry, 0o644);
  // Model Doctor's schema effect and its non-writable-parent update contract.
  // The controller's snapshot, input capture, preservation and publication remain real.
  writeFileSync(entry, `const fs=require('node:fs'),{DatabaseSync}=require('node:sqlite');
if(process.getuid()!==1000||process.argv.slice(2).join(' ')!=='doctor --repair --non-interactive --no-workspace-suggestions')throw Error('unexpected Doctor boundary');
const config=JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH));
console.log(JSON.stringify({uid:process.getuid(),preference:config.syntheticRuntimePicker??null}));
if(config.syntheticDoctorFailure)process.exit(17);
if(process.env.OPENCLAW_UPDATE_IN_PROGRESS!=='1'){
  config.wizard={lastRunCommand:'doctor'};
  fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH+'.next',JSON.stringify(config));
  fs.renameSync(process.env.OPENCLAW_CONFIG_PATH+'.next',process.env.OPENCLAW_CONFIG_PATH);
}
const db=new DatabaseSync(process.env.OPENCLAW_STATE_DIR+'/state/openclaw.sqlite');
db.exec('BEGIN IMMEDIATE; PRAGMA user_version=18; UPDATE schema_meta SET schema_version=18; COMMIT');db.close();
`);
  f.proof("manifest", [f.candidate, "b".repeat(40), process.getuid(), "b".repeat(40)]);
  f.proof("seal-tree", [f.candidate]);
  rmSync(join(f.serving, "current")); symlinkSync(f.initial, join(f.serving, "current"));
  rmSync(join(f.serving, "previous"));
  const processRoot = join(f.env.OPENCLAW_TEAM_PROC_ROOT, "111");
  mkdirSync(processRoot);
  writeFileSync(join(processRoot, "stat"), `111 (fixture gateway) S ${Array(18).fill("0").join(" ")} 1110 0 0 0 0\n`);
  symlinkSync(f.initial, join(processRoot, "cwd"));
  const record = f.load().record;
  record.candidate = JSON.parse(f.proof("validate-release", [f.candidate, "b".repeat(40), process.getuid(), "sealed"]));
  record.phase = phase === "prepared" ? "A_PREPARED" : "AGENT_REHEARSAL";
  record.agentMigration.phase = phase;
  if (phase === "rehearsal") {
    record.suspension = null;
    writeFileSync(f.permit, '{"version":1,"purpose":"gateway-start-permit"}\n', { mode: 0o600 });
  }
  record.protectedPaths = JSON.parse(f.proof("fingerprint", [f.config, f.shared]));
  const preflightPath = join(f.stage, record.agentMigration.artifacts.preflight.name);
  function writePreflight(value) {
    writeFileSync(preflightPath, JSON.stringify(value), { mode: 0o600 });
    const file = fileBinding(preflightPath);
    record.agentMigration.artifacts.preflight = { name: record.agentMigration.artifacts.preflight.name,
      device: file.device, inode: file.inode, sha256: file.sha256 };
    writeFileSync(f.journal, JSON.stringify(record));
  }
  writePreflight({ version: 1, schemaProfile: { from: record.predecessor.schemaVersions, to: record.candidate.schemaVersions },
    candidate: record.candidate.sha, completeClosure: true, dataReady: true,
    config: fileBinding(f.config), databaseBytes: stat(f.shared).size });
  const inspect = () => f.run("migration-rehearsal-inputs", [f.journal, f.serving, JSON.stringify(f.load()), 1000]);
  const refresh = (preload, unlocked = false) => {
    const args = ["--no-warnings", ...(preload ? ["--import", preload] : []), f.library, "migration-rehearse",
      f.journal, f.serving, JSON.stringify(f.load()), f.config, f.shared, f.runtime, 1000, 1000, 2400];
    return spawnSync(f.realCommands.bash, ["-c", `exec 9<>${quote(f.lockFile)}\n${unlocked ? ":" : `${quote(f.realCommands.flock)} -n 9`}\nproof() { "$@"; }\noutput="$(proof "$@")"\nresult=$?\nprintf '%s\\n' "$output"\nexit "$result"`,
      "rehearsal-owner", process.execPath, ...args.map(String)],
    { cwd: f.root, env: f.env, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 });
  };
  const edit = (atomic = false, failure = false) => {
    const value = { ...JSON.parse(readFileSync(f.config)), syntheticRuntimePicker: "authored-selection",
      ...(failure ? { syntheticDoctorFailure: true } : {}) };
    if (atomic) {
      writeFileSync(`${f.config}.next`, JSON.stringify(value), { mode: 0o600 });
      chownSync(`${f.config}.next`, 1000, 1000);
      renameSync(`${f.config}.next`, f.config);
    } else writeFileSync(f.config, JSON.stringify(value));
  };
  const attempts = () => readdirSync(f.stage).filter(name => name.startsWith("rehearsal-"));
  return { ...f, record, processRoot, preflightPath, writePreflight, inspect, refresh, edit, attempts };
}

for (const [phase, atomic] of [["prepared", false], ["prepared", true], ["rehearsal", true]]) {
  test(`${phase} warm proof refresh preserves ${atomic ? "atomic" : "in-place"} authored config and original evidence`, namespace, t => {
    const f = warmRehearsalFixture(t, phase), oldJournal = readFileSync(f.journal), oldEvidence = f.load();
    const oldPreflight = readFileSync(f.preflightPath), oldWarm = readFileSync(f.warm);
    const oldShared = fileBinding(f.shared), oldPermit = existsSync(f.permit) ? fileBinding(f.permit) : null;
    const oldAgents = f.agents.map(store => fileBinding(store.path));
    f.edit(atomic);
    const authored = fileBinding(f.config);
    const stale = f.run("migration-preflight-check", [f.journal, f.serving, JSON.stringify(f.load())]);
    assert.equal(stale.status, 2);
    assert.match(stale.stderr, /stale candidate\/config binding/);
    const updated = JSON.parse(f.succeeds(f.refresh()));
    const unchanged = structuredClone(updated.record);
    unchanged.protectedPaths[0] = oldEvidence.record.protectedPaths[0];
    unchanged.agentMigration.artifacts.preflight = oldEvidence.record.agentMigration.artifacts.preflight;
    assert.deepEqual(unchanged, oldEvidence.record);
    assert.deepEqual(updated.identity.stage, oldEvidence.identity.stage);
    assert.notDeepEqual(updated.record.agentMigration.artifacts.preflight, oldEvidence.record.agentMigration.artifacts.preflight);
    assert.deepEqual(fileBinding(f.config), authored);
    assert.deepEqual(fileBinding(f.shared), oldShared, "isolated Doctor must not migrate the serving database");
    assert.deepEqual(f.agents.map(store => fileBinding(store.path)), oldAgents);
    assert.deepEqual(existsSync(f.permit) ? fileBinding(f.permit) : null, oldPermit);
    assert.deepEqual(readFileSync(f.preflightPath), oldPreflight);
    assert.deepEqual(readFileSync(f.warm), oldWarm);
    assert.equal(f.attempts().length, 1);
    const directory = join(f.stage, f.attempts()[0]);
    assert.deepEqual(readFileSync(join(directory, "previous-journal.json")), oldJournal);
    assert.deepEqual(JSON.parse(readFileSync(join(directory, "previous-preflight-binding.json"))),
      { journal: oldEvidence.identity, preflight: oldEvidence.record.agentMigration.artifacts.preflight });
    assert.deepEqual(JSON.parse(readFileSync(join(directory, "doctor.stdout"))), { uid: 1000, preference: "authored-selection" });
    assert.equal(JSON.parse(readFileSync(join(directory, "doctor.outcome.json"))).status, 0);
    assert.deepEqual(f.artifact("preflight").config, authored);
    assert.equal(f.proof("migration-preflight-check", [f.journal, f.serving, JSON.stringify(updated)]), "PREFLIGHT_OK");
    assert.equal(JSON.parse(f.succeeds(f.inspect())).status, "current");
    const acceptedJournal = fileBinding(f.journal), attempts = f.attempts();
    assert.deepEqual(JSON.parse(f.succeeds(f.refresh())), updated, "retry must reuse accepted proof");
    assert.deepEqual(fileBinding(f.journal), acceptedJournal);
    assert.deepEqual(f.attempts(), attempts);
  });
}

test("read-only warm inspection reports config refresh work without changing admission", linux, t => {
  const f = warmRehearsalFixture(t), before = fileBinding(f.journal);
  assert.equal(JSON.parse(f.succeeds(f.inspect())).status, "current");
  f.edit(true);
  const inputs = JSON.parse(f.succeeds(f.inspect()));
  assert.equal(inputs.status, "warm-config-refresh-required");
  assert.deepEqual(inputs.config, fileBinding(f.config));
  assert.deepEqual(inputs.process, { pid: 111, generation: "1110" });
  assert.equal(inputs.permit, null);
  assert.deepEqual(fileBinding(f.journal), before);
  assert.deepEqual(f.attempts(), []);
  assert.equal(existsSync(f.permit), false);
});

test("current warm proof and current explicit waiver are reused without copying or publication", linux, t => {
  const f = warmRehearsalFixture(t);
  for (const waived of [false, true]) {
    if (waived) {
      const value = f.artifact("preflight");
      delete value.completeClosure; delete value.dataReady;
      f.writePreflight({ ...value, kind: "operator-waived", scope: "warm-copy-only" });
    }
    const before = fileBinding(f.journal), evidence = f.load();
    assert.equal(JSON.parse(f.succeeds(f.inspect())).status, "current");
    assert.deepEqual(JSON.parse(f.succeeds(f.refresh())), evidence);
    assert.deepEqual(fileBinding(f.journal), before);
    assert.deepEqual(f.attempts(), []);
  }
  f.edit();
  const before = readFileSync(f.journal), refused = f.refresh();
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /waiver/);
  assert.deepEqual(readFileSync(f.journal), before);
  assert.deepEqual(f.attempts(), []);
});

for (const fault of ["claim", "candidate", "config-hash-missing", "config-hash-invalid", "config-size-missing", "config-size-invalid", "config-shape", "policy"]) {
  test(`warm refresh refuses invalid ${fault} before creating replacement evidence`, linux, t => {
    const f = warmRehearsalFixture(t);
    f.edit();
    if (fault === "policy") {
      const config = JSON.parse(readFileSync(f.config)); config.update.auto.enabled = true;
      writeFileSync(f.config, JSON.stringify(config));
    } else {
      const proof = f.artifact("preflight");
      if (fault === "claim") proof.dataReady = false;
      else if (fault === "candidate") proof.candidate = "c".repeat(40);
      else if (fault === "config-hash-missing") delete proof.config.sha256;
      else if (fault === "config-hash-invalid") proof.config.sha256 = "not-a-digest";
      else if (fault === "config-size-missing") delete proof.config.size;
      else if (fault === "config-size-invalid") proof.config.size = -1;
      else proof.config.unbound = true;
      f.writePreflight(proof);
    }
    const before = readFileSync(f.journal), result = f.refresh();
    assert.ifError(result.error);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, fault === "policy" ? /policy is invalid/
      : fault.startsWith("config-") ? /rehearsal config/ : /candidate\/config binding/);
    assert.deepEqual(readFileSync(f.journal), before);
    assert.deepEqual(f.attempts(), []);
    assert.equal(existsSync(f.permit), false);
  });
}

for (const phase of ["B_PREVIOUS_PUBLISHED", "C_CURRENT_SELECTED", "ROLLBACK_FAILED", "doctor-started", "stores-verified", "cold-artifact", "stopped"]) {
  test(`warm refresh refuses ${phase} without replacing original proof`, linux, t => {
    const f = warmRehearsalFixture(t), record = f.load().record;
    const attach = kind => {
      const name = `${kind}-${randomUUID()}.json`, path = join(f.stage, name);
      writeFileSync(path, "{}", { mode: 0o600 });
      const file = fileBinding(path);
      record.agentMigration.artifacts[kind] = { name, device: file.device, inode: file.inode, sha256: file.sha256 };
    };
    if (phase === "stopped") rmSync(f.processRoot, { recursive: true });
    else if (phase === "cold-artifact") attach("inventory");
    else if (phase === "doctor-started" || phase === "stores-verified") {
      record.phase = phase === "doctor-started" ? "C_CURRENT_SELECTED" : "D_VERIFYING";
      record.agentMigration.phase = phase;
      for (const kind of ["inventory", "witness", "backups", ...(phase === "stores-verified" ? ["ready"] : [])]) attach(kind);
    } else record.phase = phase;
    writeFileSync(f.journal, JSON.stringify(record));
    f.edit();
    const before = readFileSync(f.journal), preflight = readFileSync(f.preflightPath);
    const result = f.refresh();
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, phase === "stopped" ? /ENOENT|original running predecessor/ : /warm preflight before cold work/);
    assert.deepEqual(readFileSync(f.journal), before);
    assert.deepEqual(readFileSync(f.preflightPath), preflight);
    assert.equal(existsSync(f.permit), false);
    assert.deepEqual(f.attempts(), []);
  });
}

for (const fault of ["config", "database", "process", "lock", "journal", "permit", "pointer"]) {
  test(`warm refresh refuses ${fault} drift after copied verification`, namespace, t => {
    const f = warmRehearsalFixture(t);
    f.edit(true);
    const before = readFileSync(f.journal), preflight = readFileSync(f.preflightPath);
    const preload = join(f.root, "refresh-drift.mjs"), reached = join(f.root, "verified-copy");
    const mutations = {
      config: `fs.appendFileSync(${JSON.stringify(f.config)},' ');`,
      database: `fs.renameSync(${JSON.stringify(f.shared)},${JSON.stringify(f.shared + ".original")});fs.copyFileSync(${JSON.stringify(f.shared + ".original")},${JSON.stringify(f.shared)});`,
      process: `fs.writeFileSync(${JSON.stringify(join(f.processRoot, "stat"))},'111 (fixture gateway) S ${Array(18).fill("0").join(" ")} 1111 0 0 0 0\\n');`,
      lock: `fs.renameSync(${JSON.stringify(f.lockFile)},${JSON.stringify(f.lockFile + ".original")});fs.writeFileSync(${JSON.stringify(f.lockFile)},'',{mode:0o600});`,
      journal: `fs.appendFileSync(${JSON.stringify(f.journal)},'\\n');`,
      permit: `fs.writeFileSync(${JSON.stringify(f.permit)},'{"version":1,"purpose":"gateway-start-permit"}\\n',{mode:0o600});`,
      pointer: `fs.unlinkSync(${JSON.stringify(join(f.serving, "current"))});fs.symlinkSync(${JSON.stringify(f.initial)},${JSON.stringify(join(f.serving, "current"))});`,
    };
    writeFileSync(preload, `import cp from 'node:child_process';import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
const spawn=cp.spawnSync;cp.spawnSync=function(command,args,options){const result=spawn(command,args,options);
if(command==='/usr/bin/bwrap'&&args.includes('migration-copy-check')&&result.status===0){fs.writeFileSync(${JSON.stringify(reached)},'yes');${mutations[fault]}}
return result;};syncBuiltinESMExports();`);
    const result = f.refresh(preload);
    assert.ifError(result.error);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(readFileSync(reached, "utf8"), "yes", "fault must occur after actual copied verification");
    assert.match(result.stderr, /config changed|protected path|database binding|original running predecessor|lock was replaced|journal bytes|inputs or controller changed/);
    assert.deepEqual(readFileSync(f.journal), fault === "journal" ? Buffer.concat([before, Buffer.from("\n")]) : before);
    assert.deepEqual(readFileSync(f.preflightPath), preflight);
    assert.equal(existsSync(f.permit), fault === "permit", "refresh cannot change the observed permit truth");
    assert.equal(f.attempts().length, 1);
    assert.deepEqual(readFileSync(join(f.stage, f.attempts()[0], "previous-journal.json")), before);
  });
}

test("failed copied Doctor and absent inherited lock retain the previous warm proof", namespace, t => {
  const f = warmRehearsalFixture(t);
  f.edit(true, true);
  const before = readFileSync(f.journal), preflight = readFileSync(f.preflightPath);
  const unlocked = f.refresh(undefined, true);
  assert.equal(unlocked.status, 2);
  assert.match(unlocked.stderr, /exclusive lock description/);
  assert.deepEqual(f.attempts(), []);
  const failed = f.refresh();
  assert.ifError(failed.error);
  assert.equal(failed.status, 2, failed.stderr);
  assert.match(failed.stderr, /isolated copied-state doctor failed/);
  assert.deepEqual(readFileSync(f.journal), before);
  assert.deepEqual(readFileSync(f.preflightPath), preflight);
  assert.equal(existsSync(f.permit), false);
  assert.equal(f.attempts().length, 1);
  const directory = join(f.stage, f.attempts()[0]);
  assert.equal(JSON.parse(readFileSync(join(directory, "doctor.outcome.json"))).status, 17);
  assert.deepEqual(readFileSync(join(directory, "previous-journal.json")), before);
  assert.equal(f.load().record.agentMigration.artifacts.inventory, undefined);
});

for (const version of [16,17]) test(`cold capture at schema ${version} retains its real baseline and verifies forward`, localSqlite, t=>{
  const f=fixture(t,version);const warm=readFileSync(f.warm);const first=JSON.parse(f.succeeds(f.cold()));const inventory=f.artifact('inventory'),backups=f.artifact('backups');
  assert.equal(inventory.stores.find(s=>s.agentId===null).version,version);
  assert.equal(inventory.coldBaseline?.kind,version===17?'already-target-before-doctor':undefined);
  const snapshot=backups.find(s=>s.source===f.shared);const db=new DatabaseSync(snapshot.file.path,{readOnly:true});assert.equal(db.prepare('PRAGMA user_version').get().user_version,version);assert.equal(db.prepare('SELECT value FROM retained_data').get().value,'latest current data');db.close();
  assert.deepEqual(JSON.parse(f.succeeds(f.cold())).record.agentMigration.artifacts,first.record.agentMigration.artifacts);
  if(version===16){const current=new DatabaseSync(f.shared);current.exec("PRAGMA user_version=17; UPDATE schema_meta SET schema_version=17");current.close();}
  const transitioned=JSON.parse(f.proof('migration-transition',[f.journal,f.serving,JSON.stringify(f.load()),'@stdin'],JSON.stringify({phase:'doctor-started'})));
  const verified=JSON.parse(f.proof('migration-verify-stores',[f.journal,f.serving,JSON.stringify(transitioned),f.config,f.shared]));
  assert.equal(verified.record.agentMigration.phase,'stores-verified');
  assert.equal(f.proof('migration-session-proof',[f.journal,f.serving,JSON.stringify(verified)]),version===17?'recovery-pre-doctor-already-target':'original-pre-migration');
  assert.deepEqual(readFileSync(f.warm),warm);assert.equal(existsSync(f.permit),false);
});

for(const [name,version,agentVersion] of [['unsupported shared schema',18,19],['mixed agent schema',17,18]]) test(name+' refuses before cold evidence',localSqlite,t=>{
 const f=fixture(t,version,agentVersion),before=readFileSync(f.journal);const r=f.cold();assert.notEqual(r.status,0);assert.match(r.stderr,/schema|registry/);assert.deepEqual(readFileSync(f.journal),before);
});

test('recorded source baseline never recaptures already-upgraded data',localSqlite,t=>{
 const f=fixture(t,16);f.succeeds(f.cold());const before=readFileSync(f.journal);const db=new DatabaseSync(f.shared);db.exec('PRAGMA user_version=17; UPDATE schema_meta SET schema_version=17');db.close();const r=f.cold();assert.notEqual(r.status,0);assert.match(r.stderr,/physical schema/);assert.deepEqual(readFileSync(f.journal),before);
});

test('interrupted inventory capture reuses target baseline and completes only missing artifacts',localSqlite,t=>{
 const f=fixture(t);const preload=join(f.root,'interrupt.mjs');writeFileSync(preload,`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const rename=fs.renameSync;fs.renameSync=function(a,b){const r=rename(a,b);if(b===${JSON.stringify(f.journal)}){const j=JSON.parse(fs.readFileSync(b));if(j.agentMigration.artifacts.inventory&&!j.agentMigration.artifacts.witness)process.exit(73);}return r};syncBuiltinESMExports();`);
 const interrupted=f.cold(preload);assert.equal(interrupted.status,73,interrupted.stderr);const saved=f.load().record.agentMigration.artifacts.inventory;f.succeeds(f.cold());assert.deepEqual(f.load().record.agentMigration.artifacts.inventory,saved);assert.equal(f.artifact('inventory').coldBaseline.kind,'already-target-before-doctor');
});

test('missing immutable inventory refuses recapture',localSqlite,t=>{
 const f=fixture(t);f.succeeds(f.cold());const e=f.load();rmSync(join(f.stage,e.record.agentMigration.artifacts.inventory.name));const before=readFileSync(f.journal);const r=f.run('migration-cold-backup',[f.journal,f.serving,JSON.stringify(e),f.config,f.shared,f.env.OPENCLAW_TEAM_PROC_ROOT]);assert.notEqual(r.status,0);assert.deepEqual(readFileSync(f.journal),before);
});


test('inconsistent physical metadata and active writers still block target baseline capture',localSqlite,t=>{
 for(const failure of ['metadata','writer']){
  const f=fixture(t);const before=readFileSync(f.journal);
  if(failure==='metadata'){const db=new DatabaseSync(f.shared);db.exec('UPDATE schema_meta SET schema_version=16');db.close();}
  else {const proc=join(f.env.OPENCLAW_TEAM_PROC_ROOT,'777');mkdirSync(join(proc,'fd'),{recursive:true});mkdirSync(join(proc,'fdinfo'));symlinkSync(f.shared,join(proc,'fd/1'));writeFileSync(join(proc,'fdinfo/1'),'flags:\t02\n');writeFileSync(join(proc,'maps'),'');}
  const result=f.cold();assert.notEqual(result.status,0);assert.match(result.stderr,failure==='metadata'?/physical schema/:/writable migration database descriptor/);assert.deepEqual(readFileSync(f.journal),before);
 }
});

function coldFixture(t, source = 19) {
  const f = fixture(t, source === 24 ? 20 : source === 23 ? 19 : 17, source, source === 24 ? "writer-validation" : source === 23 ? "snapshots" : source === 22 ? "storage" : source === 21 ? "fts" : source === 20 ? "validation" : "cold");
  f.succeeds(f.cold());
  f.proof("migration-transition", [f.journal, f.serving, JSON.stringify(f.load()), "@stdin"], JSON.stringify({ phase: "doctor-started" }));
  return f;
}

// These model Doctor version commits to exercise the real owner verifier, not
// schema 21/22/23/24/25's tables/triggers. Separate installed proof must run actual Doctor.
function modelAgentCommit(f, register = true, store = f.agents[0]) {
  const db = new DatabaseSync(store.path);
  db.exec("BEGIN IMMEDIATE");
  if (f.toAgent === 20) db.exec(readFileSync(new URL("./agent20-cold-schema.fixture.sql", import.meta.url), "utf8"));
  db.exec(`PRAGMA user_version=${f.toAgent}; UPDATE schema_meta SET schema_version=${f.toAgent}; COMMIT`);
  db.close();
  if (register) {
    const shared = new DatabaseSync(f.shared);
    shared.prepare("UPDATE agent_databases SET schema_version=? WHERE agent_id=?").run(f.toAgent, store.agentId);
    shared.close();
  }
}

const verifyCold = f => f.run("migration-verify-stores", [f.journal, f.serving, JSON.stringify(f.load()), f.config, f.shared]);

function authorityFixture(t, source, version = source) {
  const f = fixture(t, version, 23, source === 17 ? "publication" : "channel");
  if (source !== 17) return f;
  const db = new DatabaseSync(f.shared);
  db.exec(`CREATE TABLE github_publication_session_lifecycles(id TEXT PRIMARY KEY, receipt_json TEXT);
    CREATE TABLE github_repository_publication_requests(id TEXT PRIMARY KEY, receipt_json TEXT);`);
  for (const table of ["github_publication_session_lifecycles", "github_repository_publication_requests"])
    db.prepare(`INSERT INTO ${table} VALUES(?,?)`).run("original-request", '{ "result": "accepted 🦞", "authority": null }');
  db.close();
  return f;
}

function modelStateCommit(f) {
  // Models the already-committed native result for controller recovery proof.
  // Native schema and authority semantics run in the separate source lane.
  const db = new DatabaseSync(f.shared);
  db.exec("BEGIN IMMEDIATE");
  if (f.fromState === 17) db.exec(`
    ALTER TABLE github_publication_session_lifecycles ADD COLUMN requester_authority_json TEXT;
    ALTER TABLE github_repository_publication_requests ADD COLUMN requester_authority_json TEXT;`);
  db.exec(`PRAGMA user_version=${f.toState}; UPDATE schema_meta SET schema_version=${f.toState};
    INSERT INTO config_machine_state VALUES('state.schema.contentVersion','${f.toState}'); COMMIT;`);
  db.close();
}

for (const source of [17, 18]) {
test(`state ${source + 1} preserves original state ${source} evidence through a committed Doctor failure and forward verification`, localSqlite, t => {
  const f = authorityFixture(t, source);
  f.succeeds(f.cold());
  const artifacts = f.load().record.agentMigration.artifacts;
  const backups = f.artifact("backups"), originalBytes = backups.map(row => readFileSync(row.file.path));
  const witness = readFileSync(join(f.stage, artifacts.witness.name)), warm = readFileSync(f.warm);
  assert.equal(backups.length, 3);
  const inventory = f.artifact("inventory");
  assert.equal(inventory.coldBaseline, undefined);
  assert.deepEqual(inventory.stores.map(store => [store.agentId, store.version]).sort(),
    [[null, source], ["helper", 23], ["controller-test-agent", 23]].sort());
  f.proof("migration-transition", [f.journal, f.serving, JSON.stringify(f.load()), "@stdin"], JSON.stringify({ phase: "doctor-started" }));
  modelStateCommit(f);
  assert.equal(existsSync(f.permit), false);
  const resumed = f.load();
  assert.equal(resumed.record.agentMigration.phase, "doctor-started");
  assert.deepEqual(resumed.record.agentMigration.artifacts, artifacts);
  const refused = f.cold();
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /cold backup requires stopped selected candidate before Doctor/);
  const verified = JSON.parse(f.succeeds(verifyCold(f)));
  assert.equal(verified.record.agentMigration.phase, "stores-verified");
  assert.equal(f.proof("migration-session-proof", [f.journal, f.serving, JSON.stringify(verified)]), "original-pre-migration");
  for (const kind of ["inventory", "witness", "backups"])
    assert.deepEqual(verified.record.agentMigration.artifacts[kind], artifacts[kind]);
  assert.deepEqual(readFileSync(join(f.stage, artifacts.witness.name)), witness);
  assert.deepEqual(readFileSync(f.warm), warm);
  for (const [index, row] of backups.entries()) assert.deepEqual(readFileSync(row.file.path), originalBytes[index]);
  const old = new DatabaseSync(backups.find(row => row.source === f.shared).file.path, { readOnly: true });
  assert.equal(old.prepare("PRAGMA user_version").get().user_version, source);
  assert.equal(old.prepare("SELECT value FROM retained_data").get().value, "latest current data");
  if (source === 17) {
    assert.deepEqual(old.prepare("SELECT receipt_json FROM github_repository_publication_requests").all().map(row => row.receipt_json),
      ['{ "result": "accepted 🦞", "authority": null }']);
    assert.equal(old.prepare("SELECT name FROM pragma_table_info('github_repository_publication_requests') WHERE name='requester_authority_json'").get(), undefined);
  }
  old.close();
  assert.equal(existsSync(f.permit), false);
});

test(`state ${source + 1} refuses an unbound target-only cold baseline`, localSqlite, t => {
  const f = authorityFixture(t, source, source + 1), original = readFileSync(f.journal);
  const result = f.cold();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(`requires original state${source} cold evidence`));
  assert.deepEqual(readFileSync(f.journal), original);
  assert.equal(f.load().record.agentMigration.artifacts.inventory, undefined);
  assert.equal(existsSync(f.permit), false);
});

for (const [name, value] of [["deferred target content", String(source + 1)], ["future content", String(source + 2)],
  ["malformed JSON", "{"], ["string marker", JSON.stringify(String(source))], ["negative marker", "-1"], ["fractional marker", `${source}.5`]]) {
  test(`state ${source + 1} refuses ${name} before original evidence capture`, localSqlite, t => {
    const f = authorityFixture(t, source), db = new DatabaseSync(f.shared);
    db.prepare("INSERT INTO config_machine_state VALUES('state.schema.contentVersion',?)").run(value);
    db.close();
    const original = readFileSync(f.journal), result = f.cold();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`original state${source} cold evidence|content version is invalid`));
    assert.deepEqual(readFileSync(f.journal), original);
    assert.equal(f.load().record.agentMigration.artifacts.inventory, undefined);
    assert.equal(existsSync(f.permit), false);
  });
}

test(`state ${source + 1} rechecks content version in bound source, final stores and ready evidence`, localSqlite, t => {
  const f = authorityFixture(t, source);
  f.succeeds(f.cold());
  const original = readFileSync(f.journal);
  let db = new DatabaseSync(f.shared);
  db.prepare("INSERT INTO config_machine_state VALUES('state.schema.contentVersion',?)").run(String(source + 1));
  db.close();
  const coldRetry = f.cold();
  assert.notEqual(coldRetry.status, 0);
  assert.match(coldRetry.stderr, /content version/);
  assert.deepEqual(readFileSync(f.journal), original);
  db = new DatabaseSync(f.shared); db.exec("DELETE FROM config_machine_state WHERE state_key='state.schema.contentVersion'"); db.close();
  f.proof("migration-transition", [f.journal, f.serving, JSON.stringify(f.load()), "@stdin"], JSON.stringify({ phase: "doctor-started" }));
  modelStateCommit(f);
  db = new DatabaseSync(f.shared); db.prepare("UPDATE config_machine_state SET value_json=? WHERE state_key='state.schema.contentVersion'").run(String(source + 2)); db.close();
  const verifying = readFileSync(f.journal), rejected = verifyCold(f);
  assert.notEqual(rejected.status, 0); assert.match(rejected.stderr, /content version/);
  assert.deepEqual(readFileSync(f.journal), verifying);
  db = new DatabaseSync(f.shared); db.prepare("UPDATE config_machine_state SET value_json=? WHERE state_key='state.schema.contentVersion'").run(String(source + 1)); db.close();
  f.succeeds(verifyCold(f));
  const ready = readFileSync(f.journal);
  db = new DatabaseSync(f.shared); db.prepare("UPDATE config_machine_state SET value_json=? WHERE state_key='state.schema.contentVersion'").run(String(source + 2)); db.close();
  const permit = f.run("migration-permit-publish", [f.journal, f.serving, JSON.stringify(f.load()), f.env.OPENCLAW_TEAM_PROC_ROOT]);
  assert.notEqual(permit.status, 0); assert.match(permit.stderr, /content version/);
  assert.deepEqual(readFileSync(f.journal), ready);
  assert.equal(existsSync(f.permit), false);
});

test(`state ${source + 1} refuses missing original backup after Doctor commits`, localSqlite, t => {
  const f = authorityFixture(t, source);
  f.succeeds(f.cold());
  f.proof("migration-transition", [f.journal, f.serving, JSON.stringify(f.load()), "@stdin"], JSON.stringify({ phase: "doctor-started" }));
  modelStateCommit(f);
  rmSync(f.artifact("backups").find(row => row.source === f.shared).file.path);
  const original = readFileSync(f.journal), result = verifyCold(f);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ENOENT|original lossless backup changed/);
  assert.deepEqual(readFileSync(f.journal), original);
  assert.equal(existsSync(f.permit), false);
});

for (const phase of ["before capture", "after Doctor"]) test(`state ${source + 1} refuses agent 23 cold payloads ${phase}`, localSqlite, t => {
  const f = authorityFixture(t, source);
  if (phase === "after Doctor") {
    f.succeeds(f.cold());
    f.proof("migration-transition", [f.journal, f.serving, JSON.stringify(f.load()), "@stdin"], JSON.stringify({ phase: "doctor-started" }));
    modelStateCommit(f);
  }
  const db = new DatabaseSync(f.agent);
  db.prepare("INSERT INTO session_transcript_cold_archives VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(
    "retained-session", "generation-one", "fixture.zst", "a".repeat(64), 1, 4, 4, 1, 1, "sqlite", Buffer.from("cold"));
  db.close();
  const original = readFileSync(f.journal), result = phase === "before capture" ? f.cold() : verifyCold(f);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cold transcript payloads/);
  assert.deepEqual(readFileSync(f.journal), original);
  assert.equal(existsSync(f.permit), false);
});
}

for (const fault of ["mixed agent schema", "changed registry schema", "replaced agent database"]) {
  test(`state 19 refuses ${fault} without replacing original cold evidence`, localSqlite, t => {
    const f = authorityFixture(t, 18);
    f.succeeds(f.cold());
    f.proof("migration-transition", [f.journal, f.serving, JSON.stringify(f.load()), "@stdin"], JSON.stringify({ phase: "doctor-started" }));
    modelStateCommit(f);
    if (fault === "mixed agent schema") {
      const db = new DatabaseSync(f.agents[1].path);
      db.exec("PRAGMA user_version=22; UPDATE schema_meta SET schema_version=22"); db.close();
    } else if (fault === "changed registry schema") {
      const db = new DatabaseSync(f.shared);
      db.prepare("UPDATE agent_databases SET schema_version=22 WHERE agent_id=?").run(f.agents[1].agentId); db.close();
    } else {
      renameSync(f.agents[1].path, `${f.agents[1].path}.original`);
      writeFileSync(f.agents[1].path, readFileSync(`${f.agents[1].path}.original`), { mode: 0o600 });
      chownSync(f.agents[1].path, 1000, 1000);
    }
    const original = readFileSync(f.journal), result = verifyCold(f);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, fault === "mixed agent schema" ? /physical schema/
      : fault === "changed registry schema" ? /registry metadata/ : /physical database or registered locator/);
    assert.deepEqual(readFileSync(f.journal), original);
    assert.equal(existsSync(f.permit), false);
  });
}

function managedPluginFixture(t, f, sdk = true) {
  const base = "/var/lib/openclaw-team-local-artifacts";
  mkdirSync(base, { recursive: true, mode: 0o755 });
  const family = join(base, `test-${randomUUID()}`), plugin = join(family, "provider-fixture");
  mkdirSync(plugin, { recursive: true, mode: 0o750 }); chownSync(plugin, 0, 1000);
  chmodSync(family, 0o755);
  t.after(() => rmSync(family, { recursive: true, force: true }));
  writeFileSync(join(family, "not-a-plugin-secret"), "excluded synthetic neighbor");
  for (const [name, bytes] of [["package.json", '{"name":"fixture-plugin","type":"module"}'],
    ["openclaw.plugin.json", '{"id":"fixture-managed","configSchema":{"type":"object","properties":{}}}'],
    ["index.js", sdk ? 'import {createRequire} from "node:module"; export const schema=createRequire(import.meta.url)("openclaw/package.json").openclaw.schemaVersions.agent;' : 'export const schema=20;']]) {
    const file = join(plugin, name); writeFileSync(file, bytes, { mode: 0o440 }); chownSync(file, 0, 1000);
  }
  if (sdk) {
    mkdirSync(join(plugin, "node_modules"), { mode: 0o750 }); chownSync(join(plugin, "node_modules"), 0, 1000);
    symlinkSync(join(f.serving, "current"), join(plugin, "node_modules/openclaw"));
  }
  const config = JSON.parse(readFileSync(f.config)); config.plugins = { load: { paths: [plugin] } };
  writeFileSync(f.config, JSON.stringify(config));
  return { plugin, family };
}

for (const style of ["sealed", "SDK-linked"]) test(`managed external plugin capture retains ${style} package bytes and membership`, linux, t => {
  const f = fixture(t, 17, 19, "cold"), { plugin } = managedPluginFixture(t, f, style === "SDK-linked");
  if (style === "sealed") {
    chmodSync(plugin, 0o555); for (const name of readdirSync(plugin)) chmodSync(join(plugin, name), 0o444);
  }
  f.succeeds(f.cold());
  const inputs = new Map(f.artifact("inventory").inputs);
  assert.deepEqual(inputs.get(plugin).entries, ["index.js", ...(style === "SDK-linked" ? ["node_modules"] : []), "openclaw.plugin.json", "package.json"]);
  assert.equal(inputs.get(join(plugin, "index.js")).sha256, hash(readFileSync(join(plugin, "index.js"))));
  if (style === "SDK-linked") assert.equal(inputs.get(join(plugin, "node_modules/openclaw")).sdkLink.copyTarget, f.candidate);
  assert.equal(inputs.has(join(dirname(plugin), "not-a-plugin-secret")), false);
  const before = readFileSync(f.journal);
  chmodSync(join(plugin, "index.js"), 0o660);
  const retry = f.cold();
  assert.notEqual(retry.status, 0); assert.match(retry.stderr, /managed plugin ownership or permissions changed/);
  assert.deepEqual(readFileSync(f.journal), before);
});

for (const fault of ["writable-root", "foreign-owner", "manifest-symlink", "escaping-link", "namespace-selector"]) {
  test(`managed external plugin refuses ${fault} without admitting cold evidence`, linux, t => {
    const f = fixture(t, 17, 19, "cold"), { plugin, family } = managedPluginFixture(t, f);
    if (fault === "writable-root") chmodSync(plugin, 0o770);
    if (fault === "foreign-owner") chownSync(join(plugin, "index.js"), 1000, 1000);
    if (fault === "manifest-symlink") { rmSync(join(plugin, "openclaw.plugin.json")); symlinkSync(join(plugin, "package.json"), join(plugin, "openclaw.plugin.json")); }
    if (fault === "escaping-link") symlinkSync("/etc", join(plugin, "outside"));
    if (fault === "namespace-selector") {
      const config = JSON.parse(readFileSync(f.config)); config.plugins.load.paths = [family]; writeFileSync(f.config, JSON.stringify(config));
    }
    const before = readFileSync(f.journal), result = f.cold();
    assert.notEqual(result.status, 0); assert.deepEqual(readFileSync(f.journal), before);
  });
}

test("real rehearsal namespace reads private managed plugin and candidate SDK as runtime UID", {
  ...linux, skip: linux.skip || !existsSync("/usr/bin/bwrap") ? "isolated Linux root with bubblewrap required" : false,
}, t => {
  const f = fixture(t, 17, 19, "cold"), { plugin, family } = managedPluginFixture(t, f);
  const record = f.load().record;
  record.phase = "AGENT_REHEARSAL"; record.suspension = null; record.agentMigration.phase = "rehearsal"; record.agentMigration.artifacts = {};
  writeFileSync(f.journal, JSON.stringify(record));
  rmSync(join(f.serving, "current")); symlinkSync(f.initial, join(f.serving, "current")); rmSync(join(f.serving, "previous"));
  // Test-only module exposes unchanged helper bodies, without adding a production test API.
  // The native migration entry still owns all capture and namespace construction below.
  const helper = join(f.root, "copied-config-proof.mjs"), source = readFileSync(f.library, "utf8");
  const driver = source.lastIndexOf("\ntry {\n"); assert.ok(driver > 0);
  writeFileSync(helper, source.slice(0, driver) + "\nexport {configRepairCopiedInputs,migrationVerifyInputBytes};\n");
  const script = `import fs from 'node:fs'; import {pathToFileURL} from 'node:url';
import {migrationVerifyInputBytes} from '/run/copied-config-proof.mjs';
const plugin=${JSON.stringify(plugin)}; const entry=await import(pathToFileURL(plugin+'/index.js'));
let readonly=false;try{fs.chmodSync(plugin+'/index.js',0o600)}catch(e){readonly=e.code==='EROFS'};
const copied=JSON.parse(fs.readFileSync('/run/migration-proof/copied-config-inputs.json'));migrationVerifyInputBytes(copied,true);
const wrong=structuredClone(copied);wrong.find(([p])=>p===plugin+'/node_modules/openclaw')[1].sdkLink.copyTarget=${JSON.stringify(f.initial)};
let wrongSdkRejected=false;try{migrationVerifyInputBytes(wrong,true)}catch{wrongSdkRejected=true};
const result={uid:process.getuid(),gid:process.getgid(),schema:entry.schema,readonly,neighbor:fs.existsSync(${JSON.stringify(join(family, "not-a-plugin-secret"))}),target:fs.readlinkSync(plugin+'/node_modules/openclaw'),copiedConfig:true,wrongSdkRejected};
console.log(JSON.stringify(result));process.exit(73);`;
  const preload = join(f.root, "namespace-probe.mjs");
  writeFileSync(preload, `import cp from 'node:child_process';import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
import {configRepairCopiedInputs} from ${JSON.stringify(helper)};
const spawn=cp.spawnSync;cp.spawnSync=function(command,args,options){if(command==='/usr/bin/bwrap'){
const directory=args[args.indexOf('/run/migration-proof')-1];const manifest=JSON.parse(fs.readFileSync(directory+'/copy-manifest.json'));
fs.writeFileSync(directory+'/copied-config-inputs.json',JSON.stringify(configRepairCopiedInputs(manifest.inputs)),{mode:0o600});
const end=args.lastIndexOf('--chdir')+2;return spawn(command,[...args.slice(0,end),'--ro-bind',${JSON.stringify(helper)},'/run/copied-config-proof.mjs','/usr/bin/node','--input-type=module','-e',${JSON.stringify(script)}],options);}return spawn(command,args,options);};syncBuiltinESMExports();`);
  const result = f.run("migration-rehearse", [f.journal, f.serving, JSON.stringify(f.load()), f.config, f.shared, f.runtime, 1000, 1000, 2400], undefined, preload);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /isolated copied-state doctor failed/);
  const directory = readdirSync(f.stage).find(name => name.startsWith("rehearsal-"));
  const output = readFileSync(join(f.stage, directory, "doctor.stdout"), "utf8");
  assert.ok(output.trim(), readFileSync(join(f.stage, directory, "doctor.stderr"), "utf8"));
  const probe = JSON.parse(output);
  assert.deepEqual(probe, { uid: 1000, gid: 1000, schema: 20, readonly: true, neighbor: false, target: f.candidate, copiedConfig: true, wrongSdkRejected: true });
  assert.equal(realpathSync(join(plugin, "node_modules/openclaw")), f.initial);
  assert.deepEqual(f.load().record.agentMigration.artifacts, {});
});

for (const source of [19, 20, 21, 22, 23, 24]) test(`agent ${source}-to-${source + 1} accepts native Doctor session route normalization with original evidence`, localSqlite, t => {
  const f = fixture(t, source === 24 ? 20 : source === 23 ? 19 : 17, source, source === 24 ? "writer-validation" : source === 23 ? "snapshots" : source === 22 ? "storage" : source === 21 ? "fts" : source === 20 ? "validation" : "cold");
  const db = new DatabaseSync(f.agent);
  db.exec("ALTER TABLE session_nodes ADD COLUMN entry_json TEXT; ALTER TABLE session_nodes ADD COLUMN updated_at INTEGER");
  const entry = { sessionId: "retained-session", agentHarnessId: "codex", providerOverride: "openai", modelOverrideSource: "user", updatedAt: 1 };
  db.prepare("UPDATE session_nodes SET entry_json=?,updated_at=1").run(JSON.stringify(entry));
  db.close();
  f.succeeds(f.cold());
  const original = f.load().record.agentMigration.artifacts;
  f.proof("migration-transition", [f.journal, f.serving, JSON.stringify(f.load()), "@stdin"], JSON.stringify({ phase: "doctor-started" }));
  for (const store of f.agents) modelAgentCommit(f, true, store);
  // Model the observed native repair of an unlocked stale runtime pin. Doctor owns this normalization.
  const repaired = { ...entry, updatedAt: 2 }; delete repaired.agentHarnessId;
  const current = new DatabaseSync(f.agent);
  current.prepare("UPDATE session_nodes SET entry_json=?,updated_at=2").run(JSON.stringify(repaired)); current.close();
  f.succeeds(verifyCold(f));
  for (const kind of ["inventory", "witness", "backups"])
    assert.deepEqual(f.load().record.agentMigration.artifacts[kind], original[kind]);
  const backup = f.artifact("backups").find(row => row.source === f.agent);
  const old = new DatabaseSync(backup.file.path, { readOnly: true });
  assert.deepEqual(JSON.parse(old.prepare("SELECT entry_json FROM session_nodes").get().entry_json), entry); old.close();
  assert.equal(existsSync(f.permit), false);
});

for (const source of [19, 20, 21, 22, 23, 24]) test(`agent ${source}-to-${source + 1} does not recapture an already-target agent baseline`, localSqlite, t => {
  const f = fixture(t, source === 24 ? 20 : source === 23 ? 19 : 17, source + 1, source === 24 ? "writer-validation" : source === 23 ? "snapshots" : source === 22 ? "storage" : source === 21 ? "fts" : source === 20 ? "validation" : "cold"), original = readFileSync(f.journal);
  const result = f.cold();
  assert.notEqual(result.status, 0); assert.match(result.stderr, /schema|registry/);
  assert.deepEqual(readFileSync(f.journal), original); assert.equal(existsSync(f.permit), false);
});

for (const phase of ["before capture", "after Doctor"])
for (const fault of ["mixed stores", "version marker", "metadata marker", "physical identity"]) {
  test(`agent 24-to-25 refuses ${fault} ${phase} with its original fence intact`, localSqlite, t => {
    const f = phase === "before capture" ? fixture(t, 20, 24, "writer-validation") : coldFixture(t, 24);
    if (phase === "after Doctor") for (const store of f.agents) modelAgentCommit(f, true, store);
    const original = readFileSync(f.journal);
    const otherVersion = phase === "before capture" ? 25 : 24;
    if (fault === "mixed stores") {
      const db = new DatabaseSync(f.agent);
      db.exec(`PRAGMA user_version=${otherVersion}; UPDATE schema_meta SET schema_version=${otherVersion}`);
      db.close();
      const shared = new DatabaseSync(f.shared);
      shared.prepare("UPDATE agent_databases SET schema_version=? WHERE agent_id=?").run(otherVersion, f.agents[0].agentId);
      shared.close();
    } else if (fault === "physical identity") {
      // Identity is bound by cold capture, not the synthetic warm preflight.
      if (phase === "before capture") f.succeeds(f.cold());
      const captured = readFileSync(f.journal);
      renameSync(f.agent, `${f.agent}.retained`);
      writeFileSync(f.agent, readFileSync(`${f.agent}.retained`), { mode: 0o600 });
      chownSync(f.agent, 1000, 1000);
      const result = phase === "before capture" ? f.cold() : verifyCold(f);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /physical database|identity/);
      assert.deepEqual(readFileSync(f.journal), captured);
      assert.equal(existsSync(f.permit), false);
      return;
    } else {
      const db = new DatabaseSync(f.agent);
      db.exec(fault === "version marker" ? `PRAGMA user_version=${otherVersion}` : `UPDATE schema_meta SET schema_version=${otherVersion}`);
      db.close();
    }
    const result = phase === "before capture" ? f.cold() : verifyCold(f);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /schema|registry/);
    assert.deepEqual(readFileSync(f.journal), original);
    assert.equal(existsSync(f.permit), false);
  });
}

test("agent 24-to-25 accepts native Doctor retirement of Workshop proposal tables", localSqlite, t => {
  const f = coldFixture(t, 24), original = f.load().record.agentMigration.artifacts;
  for (const store of f.agents) modelAgentCommit(f, true, store);
  // Doctor owns draft export and table retirement; model its committed database result.
  const db = new DatabaseSync(f.shared); db.exec("DROP TABLE skill_workshop_proposals"); db.close();
  f.succeeds(verifyCold(f));
  for (const kind of ["inventory", "witness", "backups"])
    assert.deepEqual(f.load().record.agentMigration.artifacts[kind], original[kind]);
  assert.equal(existsSync(f.permit), false);
});

for (const archive of ["retained", "missing", "corrupt"]) test(`agent 19-to-20 checks original witness against ${archive} retired-session archive`, localSqlite, t => {
  const f = fixture(t, 17, 19, "cold");
  const db = new DatabaseSync(f.agent);
  db.exec("ALTER TABLE session_nodes ADD COLUMN entry_json TEXT; ALTER TABLE session_nodes ADD COLUMN updated_at INTEGER; ALTER TABLE session_transcript_archives ADD COLUMN session_key TEXT");
  const bytes = Buffer.from("synthetic retained transcript");
  db.prepare("INSERT INTO session_transcript_archives VALUES(?,?,?,?,?,?)").run("retained-session", "generation-one", bytes, hash(bytes), "identity", "agent:controller-test-agent:parent");
  db.close(); f.succeeds(f.cold());
  const original = f.load().record.agentMigration.artifacts;
  f.proof("migration-transition", [f.journal, f.serving, JSON.stringify(f.load()), "@stdin"], JSON.stringify({ phase: "doctor-started" }));
  modelAgentCommit(f);
  const current = new DatabaseSync(f.agent); current.exec("DELETE FROM session_nodes");
  if (archive === "missing") current.exec("DELETE FROM session_transcript_archives WHERE session_id='retained-session'");
  if (archive === "corrupt") current.exec("UPDATE session_transcript_archives SET archive_blob=X'00' WHERE session_id='retained-session'");
  current.close();
  const result = verifyCold(f); f.succeeds(result);
  if (archive === "retained") assert.doesNotMatch(result.stderr, /HISTORY_PRESERVATION_GAP/);
  else {
    assert.match(result.stderr, /WARNING HISTORY_PRESERVATION_GAPS count=1/);
    assert.match(result.stderr, archive === "missing" ? /exact-tuple-missing/ : /encoded-hash-mismatch/);
    assert.doesNotMatch(result.stderr, /agent:controller-test-agent:parent|synthetic retained transcript/);
  }
  for (const kind of ["inventory", "witness", "backups"])
    assert.deepEqual(f.load().record.agentMigration.artifacts[kind], original[kind]);
  assert.equal(existsSync(f.permit), false);
});

for (const source of [19, 20, 21, 22, 23, 24]) test(`agent ${source}-to-${source + 1} preserves original cold evidence through partial store and registry publication`, localSqlite, t => {
  const f = coldFixture(t, source), original = f.load().record.agentMigration.artifacts;
  const backups = f.artifact("backups");
  assert.equal(backups.length, f.agents.length + 1);
  if (source >= 20) {
    modelAgentCommit(f);
    const versions = f.agents.map(store => {
      const db = new DatabaseSync(store.path, { readOnly: true });
      try { return db.prepare("PRAGMA user_version").get().user_version; } finally { db.close(); }
    });
    assert.deepEqual(versions, [source + 1, source]);
    const partialStores = verifyCold(f);
    assert.notEqual(partialStores.status, 0);
    assert.match(partialStores.stderr, /registry metadata|physical schema/);
    assert.deepEqual(f.load().record.agentMigration.artifacts, original);
    const start = f.run("migration-permit-publish", [f.journal, f.serving, JSON.stringify(f.load()), f.env.OPENCLAW_TEAM_PROC_ROOT]);
    assert.notEqual(start.status, 0);
    assert.match(start.stderr, /Gateway permit requires durable verified stores/);
    assert.equal(existsSync(f.permit), false);
  }
  const last = f.agents.at(-1);
  modelAgentCommit(f, false, last);
  const partial = verifyCold(f);
  assert.notEqual(partial.status, 0);
  assert.match(partial.stderr, /registry metadata/);
  assert.equal(existsSync(f.permit), false);
  assert.deepEqual(f.load().record.agentMigration.artifacts, original);
  const shared = new DatabaseSync(f.shared);
  shared.prepare("UPDATE agent_databases SET schema_version=? WHERE agent_id=?").run(source + 1, last.agentId);
  shared.close();
  const verified = JSON.parse(f.succeeds(verifyCold(f)));
  assert.equal(verified.record.agentMigration.phase, "stores-verified");
  assert.equal(existsSync(f.permit), false);
  for (const kind of ["inventory", "witness", "backups"])
    assert.deepEqual(verified.record.agentMigration.artifacts[kind], original[kind]);
  for (const store of f.agents) {
    const backup = backups.find(row => row.source === store.path);
    const old = new DatabaseSync(backup.file.path, { readOnly: true });
    const current = new DatabaseSync(store.path, { readOnly: true });
    try {
      assert.equal(old.prepare("PRAGMA user_version").get().user_version, source);
      assert.equal(current.prepare("PRAGMA user_version").get().user_version, source + 1);
      for (const table of ["transcript_events", "session_windows", "transcript_rewrite_watermarks", "session_transcript_archives"])
        assert.deepEqual(current.prepare(`SELECT * FROM ${table}`).all(), old.prepare(`SELECT * FROM ${table}`).all());
      if (source >= 20) assert.equal(old.prepare("SELECT count(*) AS n FROM session_transcript_cold_archives").get().n, 0);
      assert.equal(current.prepare("SELECT count(*) AS n FROM session_transcript_cold_archives").get().n, 0);
    } finally { current.close(); old.close(); }
  }
});

for (const [source, phase] of [[19, "after Doctor"], [20, "before capture"], [20, "after Doctor"], [21, "before capture"], [21, "after Doctor"], [22, "before capture"], [22, "after Doctor"], [23, "before capture"], [23, "after Doctor"], [24, "before capture"], [24, "after Doctor"]])
for (const failure of ["missing cold table", "wrong cold schema", "cold payload"]) {
  test(`agent ${source}-to-${source + 1} refuses ${failure} ${phase} without releasing its fence`, localSqlite, t => {
    const f = phase === "before capture" ? fixture(t, source === 24 ? 20 : source === 23 ? 19 : 17, source, source === 24 ? "writer-validation" : source === 23 ? "snapshots" : source === 22 ? "storage" : source === 21 ? "fts" : "validation") : coldFixture(t, source);
    if (phase === "after Doctor") for (const store of f.agents) modelAgentCommit(f, true, store);
    const db = new DatabaseSync(f.agent);
    if (failure === "missing cold table") db.exec("DROP TABLE session_transcript_cold_archives");
    if (failure === "wrong cold schema") db.exec("ALTER TABLE session_transcript_cold_archives ADD COLUMN unsupported TEXT");
    if (failure === "cold payload") db.prepare("INSERT INTO session_transcript_cold_archives VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(
      "retained-session", "generation-one", "fixture.zst", "a".repeat(64), 1, 4, 4, 1, 1, "sqlite", Buffer.from("cold"));
    db.close();
    const original = readFileSync(f.journal), result = phase === "before capture" ? f.cold() : verifyCold(f);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cold transcript/);
    assert.equal(existsSync(f.permit), false);
    assert.deepEqual(readFileSync(f.journal), original);
  });
}

test("agent 19-to-20 refuses evidence substitution after Doctor commits", localSqlite, t => {
  const f = coldFixture(t);
  modelAgentCommit(f);
  const original = readFileSync(f.journal), backup = f.artifact("backups").find(row => row.source === f.agent);
  writeFileSync(backup.file.path, readFileSync(f.agent));
  const result = verifyCold(f);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /original lossless backup changed/);
  assert.equal(existsSync(f.permit), false);
  assert.deepEqual(readFileSync(f.journal), original);
});

test("real rehearsal preserves runtime archive plugin SDK and exposes only the named readonly archive", {
  ...linux, skip: linux.skip || !existsSync("/usr/bin/bwrap") ? "isolated Linux root with bubblewrap required" : false,
}, t => {
  const f = fixture(t, 17, 19, "cold"), plugin = join(f.runtime, ".openclaw/extensions/archive-plugin");
  chownSync(f.runtime, 1000, 1000);
  mkdirSync(join(plugin, "node_modules"), { recursive: true, mode: 0o755 });
  writeFileSync(join(plugin, "package.json"), '{"name":"fixture-archive","type":"module","peerDependencies":{"openclaw":"*"}}');
  writeFileSync(join(plugin, "openclaw.plugin.json"), '{"id":"fixture-archive","configSchema":{}}');
  writeFileSync(join(plugin, "index.js"), 'import {createRequire} from "node:module";export const schema=createRequire(import.meta.url)("openclaw/package.json").openclaw.schemaVersions.agent;');
  const link = join(plugin, "node_modules/openclaw"); symlinkSync(f.initial, link);
  for (const path of [dirname(plugin), plugin, join(plugin, "node_modules"), ...["package.json", "openclaw.plugin.json", "index.js"].map(name => join(plugin, name))]) chownSync(path, 1000, 1000);
  const archive = join(f.root, "archive-origin.tgz"), neighbor = join(f.root, "archive-neighbor-secret");
  writeFileSync(archive, "synthetic archive origin", { mode: 0o644 });
  writeFileSync(neighbor, "not an input", { mode: 0o600 });
  // lchown, not chown: the installed SDK link is runtime-owned; its sealed target remains root-owned.
  lchownSync(link, 1000, 1000);
  const database = new DatabaseSync(f.shared);
  database.prepare("INSERT INTO config_machine_state(state_key,value_json) VALUES(?,?)").run("plugins.installedIndex", JSON.stringify({revision:1,index:{
    plugins:[{rootDir:plugin,manifestPath:join(plugin,"openclaw.plugin.json"),source:join(plugin,"index.js")}],
    installRecords:{"fixture-archive":{source:"archive",sourcePath:archive,installPath:plugin}}
  }})); database.close();
  const record = f.load().record;
  record.phase = "AGENT_REHEARSAL"; record.suspension = null; record.agentMigration.phase = "rehearsal"; record.agentMigration.artifacts = {};
  writeFileSync(f.journal, JSON.stringify(record));
  rmSync(join(f.serving, "current")); symlinkSync(f.initial, join(f.serving, "current")); rmSync(join(f.serving, "previous"));
  const helper = join(f.root, "archive-copy-proof.mjs"), source = readFileSync(f.library, "utf8");
  const driver = source.lastIndexOf("\ntry {\n"); assert.ok(driver > 0);
  writeFileSync(helper, source.slice(0, driver) + "\nexport {configRepairCopiedInputs,migrationVerifyInputBytes};\n");
  const script = `import fs from 'node:fs';import {pathToFileURL} from 'node:url';
import {migrationVerifyInputBytes} from '/run/archive-copy-proof.mjs';
const plugin=${JSON.stringify(plugin)},archive=${JSON.stringify(archive)},entry=await import(pathToFileURL(plugin+'/index.js'));
const inputs=JSON.parse(fs.readFileSync('/run/migration-proof/archive-inputs.json'));migrationVerifyInputBytes(inputs,true);
let readonly=false;try{fs.writeFileSync(archive,'must fail')}catch(e){readonly=e.code==='EROFS'};
console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid(),schema:entry.schema,readonly,
archive:fs.readFileSync(archive,'utf8'),neighbor:fs.existsSync(${JSON.stringify(neighbor)}),target:fs.readlinkSync(plugin+'/node_modules/openclaw')}));process.exit(73);`;
  const preload = join(f.root, "archive-namespace-probe.mjs");
  writeFileSync(preload, `import cp from 'node:child_process';import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
import {configRepairCopiedInputs} from ${JSON.stringify(helper)};
const spawn=cp.spawnSync;cp.spawnSync=function(command,args,options){if(command==='/usr/bin/bwrap'){
const directory=args[args.indexOf('/run/migration-proof')-1];const manifest=JSON.parse(fs.readFileSync(directory+'/copy-manifest.json'));
fs.writeFileSync(directory+'/archive-inputs.json',JSON.stringify(configRepairCopiedInputs(manifest.inputs)),{mode:0o600});
const end=args.lastIndexOf('--chdir')+2;return spawn(command,[...args.slice(0,end),'--ro-bind',${JSON.stringify(helper)},'/run/archive-copy-proof.mjs','/usr/bin/node','--input-type=module','-e',${JSON.stringify(script)}],options);}return spawn(command,args,options);};syncBuiltinESMExports();`);
  const result = f.run("migration-rehearse", [f.journal, f.serving, JSON.stringify(f.load()), f.config, f.shared, f.runtime, 1000, 1000, 2400], undefined, preload);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /isolated copied-state doctor failed/);
  const directory = readdirSync(f.stage).find(name => name.startsWith("rehearsal-"));
  const stdout = readFileSync(join(f.stage, directory, "doctor.stdout"), "utf8");
  assert.ok(stdout.trim(), readFileSync(join(f.stage, directory, "doctor.stderr"), "utf8"));
  assert.deepEqual(JSON.parse(stdout), {uid:1000,gid:1000,schema:19,readonly:true,archive:"synthetic archive origin",neighbor:false,target:f.initial});
  assert.equal(realpathSync(link), f.initial);
  assert.equal(readFileSync(archive, "utf8"), "synthetic archive origin");
  assert.deepEqual(f.load().record.agentMigration.artifacts, {});
});
