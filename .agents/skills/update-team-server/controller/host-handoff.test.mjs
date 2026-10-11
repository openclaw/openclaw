import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, chownSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { makeRehearsalSnapshotFixture } from "./rehearsal-snapshot.test-support.mjs";
import { runOwner } from "./worker-config-owner-fixture.mjs";

const library = new URL("./release-lib.mjs", import.meta.url).pathname;
const owner = readFileSync(new URL("./openclaw-release-deploy", import.meta.url), "utf8");
const sourceId = "a".repeat(32), targetId = "b".repeat(32), targetSha = "b".repeat(40);
const linuxRoot = { skip: process.platform !== "linux" || process.getuid() !== 0 ? "requires disposable Linux root" : false };
function fixture(t) {
  const f = makeRehearsalSnapshotFixture(t);
  writeFileSync(join(f.root, "etc/machine-id"), sourceId + "\n");
  const base = JSON.parse(readFileSync(f.configPath));
  base.agents.entries = { main: {}, "registered-only": {} };
  base.agents.defaults = { ...base.agents.defaults, model: "fixture/model" };
  base.worktreeRoot = join(f.root, "old-worktrees");
  base.models = { providers: { "fixture-provider": { baseUrl: "http://127.0.0.1:23456" } } };
  writeFileSync(f.config, JSON.stringify(base), { mode: 0o600 });
  if (process.getuid() === 0) chownSync(f.config, f.runtimeUid, f.runtimeGid);
  const shared = new DatabaseSync(f.shared); shared.exec("CREATE TABLE migration_runs(id TEXT PRIMARY KEY,status TEXT,report_json TEXT)"); shared.close();
  const capacity = join(f.root, "handoff-capacity.mjs");
  writeFileSync(capacity, "import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const original=fs.statfsSync;fs.statfsSync=(...args)=>({...original(...args),bavail:16*1024*1024,bsize:4096});syncBuiltinESMExports();");
  const run = (action, args = [], input, preload) => spawnSync(process.execPath, ["--import", capacity, ...(preload ? ["--import", preload] : []), library, "host-handoff", action, f.serving, ...args], { env: f.env, input: input ? JSON.stringify(input) : undefined, encoding: "utf8", timeout: 30000 });
  const success = result => { assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  const source = JSON.parse(success(spawnSync(process.execPath, [library, "validate-release", f.initial, f.sha, String(process.getuid()), "sealed"], { env: f.env, encoding: "utf8" })));
  const admission = { source, schedules: Object.fromEntries(["openclaw-hourly-health-check.timer", "openclaw-disk-maintenance.timer"].map(name => [name, { UnitFileState: "enabled", ActiveState: "active", SubState: "waiting", LastTriggerUSec: "original-last", NextElapseUSecRealtime: "original-next" }])), process: { pid: 111, generation: "1110", instance: "fixture-instance-111" }, suspension: { id: "lease", expiresAtMs: Date.now() + 60000, status: "ready", terminalPolicy: "preserve" } };
  const begin = () => success(run("source-begin", [targetId, targetSha, f.config, f.shared, "@stdin"], admission));
  const stop = () => {
    success(run("source-revoke"));
    rmSync(join(f.env.OPENCLAW_TEAM_PROC_ROOT, "111"), { recursive: true });
    success(run("source-stopped"));
  };
  return { ...f, run, success, admission, begin, stop };
}

test("retains a real stopped source export and refuses an active start permit or process", t => {
  const f = fixture(t), originalConfig = readFileSync(f.config);
  const id = f.begin();
  assert.match(id, /^[a-f0-9-]{36}$/);
  const sourceBackup = JSON.parse(readFileSync(f.journal)).configBackup.path;
  assert.equal(lstatSync(sourceBackup).uid, process.getuid());
  assert.equal(lstatSync(sourceBackup).mode & 0o7777, 0o600);
  assert.deepEqual(readFileSync(sourceBackup), originalConfig);
  if (process.getuid() === 0) assert.equal(lstatSync(f.config).uid, f.runtimeUid);
  assert.notEqual(f.run("source-export").status, 0);
  assert.equal(existsSync(f.permit), true);
  f.success(f.run("source-revoke"));
  assert.notEqual(f.run("source-stopped").status, 0);
  assert.equal(f.success(f.run("status")), "SOURCE_PREPARED");
  f.stop();
  for (const agent of f.agents) agent.writer.close();
  const exported = JSON.parse(f.success(f.run("source-export")));
  const manifest = JSON.parse(readFileSync(exported.manifest));
  assert.equal(manifest.kind, "team-state-handoff");
  assert.equal(manifest.consistency, "quiesced-source");
  assert.equal(manifest.handoff.targetMachineId, targetId);
  assert.equal(manifest.handoff.targetSha, targetSha);
  assert.deepEqual(manifest.handoff.schedules, f.admission.schedules);
  assert.equal(exported.sourceWritersStopped, true);
  assert.equal(existsSync(f.permit), false);
  assert.equal(f.success(f.run("status")), "SOURCE_EXPORTED");
  assert.deepEqual(JSON.parse(f.success(f.run("source-export"))), exported);
  assert.deepEqual(readFileSync(f.config), originalConfig);
  assert.equal(existsSync(f.journal), true);
});

const sourceOperation = owner.match(/^handoff_source\(\) \{[\s\S]*?^\}/m)?.[0];
assert.ok(sourceOperation);
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";

for (const scenario of ["stop", "arm-failure", "stop-failure"]) {
  test(`canonical source stop preserves handoff ordering and failure state: ${scenario}`, t => {
    const root = mkdtempSync(join(tmpdir(), "team-handoff-stop-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const events = join(root, "events"), permit = join(root, "permit"), stopped = join(root, "stopped");
    writeFileSync(permit, "permitted");
    const program = `set -euo pipefail
root=${quote(root)}; events=${quote(events)}; permit=${quote(permit)}; stopped=${quote(stopped)}
serving_root="$root"; releases_root="$root/releases"; operator_expected_sha=${quote("a".repeat(40))}
current_link="$root/current"; operator_expected_pid=111; operator_expected_generation=1110
proc_root="$root/proc"; root_uid=0; handoff_peer=${quote(targetId)}; handoff_target_sha=${quote(targetSha)}
config_file="$root/config"; state_database="$root/database"; node_bin=${quote(process.execPath)}
systemctl_bin=system_systemctl; held_suspension=""; predecessor_stopped=0; handoff_stop_only=1
fail() { printf '%s\\n' "$*" >&2; return 1; }
event() { printf '%s\\n' "$*" >>"$events"; }
read_pointer() { printf '%s\\n' "$releases_root/$operator_expected_sha"; }
realpath() { read_pointer; }
assert_protected_identity() { :; }; assert_policy() { :; }; migration_native_guard() { :; }
recheck_generation() { event generation; }; assert_scheduler_owner() { event scheduler; }
read_process_instance() { printf '%s' instance; }
prepare_suspension() { event drain; held_suspension=lease; suspension_expiry=12345; suspension_state=READY; }
check_suspension() { event check-lease; }
migration_stop_contract() { event stop-contract; }
arm_suspension_handoff() { event arm; ${scenario === "arm-failure" ? "return 1" : ":"}; }
predecessor_is_stopped() { [[ -e "$stopped" ]]; }
bounded() { shift; "$@"; }
system_systemctl() {
  case "$1" in
  show) printf 'UnitFileState=enabled\\nActiveState=active\\nSubState=waiting\\nLastTriggerUSec=last\\nNextElapseUSecRealtime=next\\n' ;;
  stop) event stop; ${scenario === "stop-failure" ? "return 1" : "touch \"$stopped\""} ;;
  *) return 99 ;;
  esac
}
proof() {
  case "$1 $2" in
  'host-handoff status') printf '%s\\n' none ;;
  'host-handoff source-begin') cat >/dev/null; event journal ;;
  'host-handoff source-revoke') event revoke; rm "$permit" ;;
  'host-handoff source-stopped') [[ -e "$stopped" && ! -e "$permit" ]]; event stopped-journal ;;
  *) [[ "$1" == validate-release || "$1" == migration-guard-descriptor ]] || return 99; printf '{}' ;;
  esac
}
${sourceOperation}
handoff_source
`;
    const result = spawnSync("bash", ["-c", program], { encoding: "utf8" });
    const log = readFileSync(events, "utf8").trim().split("\n");
    if (scenario === "stop") {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /HANDOFF_STOPPED/);
      assert.ok(log.indexOf("journal") < log.indexOf("arm"));
      assert.ok(log.indexOf("arm") < log.indexOf("revoke"));
      assert.ok(log.indexOf("revoke") < log.indexOf("stop"));
      assert.ok(log.indexOf("stop") < log.indexOf("stopped-journal"));
    } else {
      assert.notEqual(result.status, 0);
      assert.equal(log.includes("stopped-journal"), false);
      assert.equal(existsSync(permit), scenario === "arm-failure");
      if (scenario === "arm-failure") assert.equal(log.includes("stop"), false);
    }
    assert.equal(log.some(value => value.includes("start") || value.includes("export")), false);
  });
}

test("stopped source export ignores PID reuse but retains database writer checks", t => {
  const f = fixture(t); f.begin(); f.stop();
  for (const agent of f.agents) agent.writer.close();
  const directory = join(f.env.OPENCLAW_TEAM_PROC_ROOT, "111");
  mkdirSync(join(directory, "fd"), { recursive: true }); mkdirSync(join(directory, "fdinfo"));
  const fields = Array(24).fill("0"); fields[0] = "S"; fields[19] = "2220";
  writeFileSync(join(directory, "stat"), `111 (unrelated reused PID) ${fields.join(" ")}\n`);
  writeFileSync(join(directory, "maps"), "");
  symlinkSync(f.shared, join(directory, "fd/1"));
  writeFileSync(join(directory, "fdinfo/1"), "flags:\t02\n");
  const refused = f.run("source-export");
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /writable migration database descriptor/);
  rmSync(join(directory, "fd/1"));
  const exported = JSON.parse(f.success(f.run("source-export")));
  assert.equal(exported.sourceWritersStopped, true);
  assert.equal(f.success(f.run("status")), "SOURCE_EXPORTED");
});

test("refuses changed source inputs and external writable database descriptors", t => {
  const f = fixture(t); f.begin();
  assert.notEqual(f.run("source-check", [f.sha, "112", "1110", targetId, targetSha]).status, 0);
  f.stop();
  const writerRoot = join(f.env.OPENCLAW_TEAM_PROC_ROOT, "777");
  mkdirSync(join(writerRoot, "fd"), { recursive: true }); mkdirSync(join(writerRoot, "fdinfo"));
  // Real filesystem identity models a retained native writer, without spawning a production process.
  symlinkSync(f.shared, join(writerRoot, "fd/1"));
  writeFileSync(join(writerRoot, "fdinfo/1"), "flags:\t02\n"); writeFileSync(join(writerRoot, "maps"), "");
  const refused = f.run("source-export");
  assert.notEqual(refused.status, 0); assert.match(refused.stderr, /writable migration database descriptor/);
  assert.equal(f.success(f.run("status")), "SOURCE_STOPPED");
});

function managedNode(f, malformed = false) {
  const sha256 = createHash("sha256").update(readFileSync(process.execPath)).digest("hex");
  writeFileSync(f.runtimeDrop, malformed ? "unowned runtime configuration\n" :
    `# OpenClaw Team Gateway runtime: node\n# SHA-256: ${sha256}\n[Service]\nExecStart=\nExecStart=${process.execPath} ${f.serving}/current/dist/index.js gateway --port 18789\n`, { mode: 0o644 });
  return sha256;
}

for (const phase of ["source", "target"]) {
  test(`handoff ${phase} binds its managed runtime before publishing a readable journal`, linuxRoot, t => {
    const f = phase === "source" ? fixture(t) : targetFixture(t);
    const sha256 = managedNode(f);
    if (phase === "source") f.begin();
    else f.success(runImport(f));
    const record = JSON.parse(readFileSync(f.journal));
    assert.equal(record.gatewayRuntime.kind, "node");
    assert.equal(record.gatewayRuntime.binary.sha256, sha256);
    assert.equal(f.success(f.run("status")), phase === "source" ? "SOURCE_PREPARED" : "TARGET_IMPORTED");
    const retained = readFileSync(f.journal);
    managedNode(f, true);
    assert.notEqual(f.run("status").status, 0);
    assert.deepEqual(readFileSync(f.journal), retained);
  });

  test(`handoff ${phase} refuses an invalid runtime before journal publication`, linuxRoot, t => {
    const f = phase === "source" ? fixture(t) : targetFixture(t);
    managedNode(f, true);
    const result = phase === "source"
      ? f.run("source-begin", [targetId, targetSha, f.config, f.shared, "@stdin"], f.admission)
      : f.run("target-import", [f.exported.manifest, f.exported.manifestSha256]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /runtime override/);
    assert.equal(existsSync(f.journal), false);
    assert.equal(existsSync(f.permit), phase === "source");
  });
}

test("default Node still reads retained handoff journals without runtime metadata", linuxRoot, t => {
  const f = fixture(t); f.begin();
  const record = JSON.parse(readFileSync(f.journal)); delete record.gatewayRuntime;
  writeFileSync(f.journal, JSON.stringify(record), { mode: 0o600 });
  assert.equal(f.success(f.run("source-check", [f.sha, "111", "1110", targetId, targetSha])), "SOURCE_PREPARED");
});


function targetFixture(t) {
  const f = fixture(t); f.begin(); f.stop();
  for (const agent of f.agents) agent.writer.close();
  const exported = JSON.parse(f.success(f.run("source-export")));
  const manifest = JSON.parse(readFileSync(exported.manifest));
  const sourceJournal = readFileSync(f.journal);
  copyFileSync(f.journal, join(f.root, "original-source-journal.json"));
  rmSync(f.journal); rmSync(join(f.serving, "current"));
  writeFileSync(join(f.root, "etc/machine-id"), targetId + "\n");
  const candidate = f.addRelease(targetSha);
  chmodSync(candidate, 0o755); chmodSync(join(candidate, "node_modules"), 0o755);
  mkdirSync(join(candidate, "node_modules/sqlite-vec"));
  writeFileSync(join(candidate, "node_modules/sqlite-vec/index.js"), "exports.load=db=>db.function('vec_version',()=> 'fixture');");
  chmodSync(join(candidate, "package.json"), 0o644);
  const candidatePackage = JSON.parse(readFileSync(join(candidate, "package.json")));
  candidatePackage.exports = { "./plugin-sdk/core": "./fixture-sdk.cjs" };
  writeFileSync(join(candidate, "package.json"), JSON.stringify(candidatePackage));
  writeFileSync(join(candidate, "fixture-sdk.cjs"), `module.exports={candidate:${JSON.stringify(targetSha)}};`);
  f.success(spawnSync(process.execPath, [library, "seal-tree", candidate], { env: f.env, encoding: "utf8" }));
  for (const snapshot of manifest.backups) {
    copyFileSync(snapshot.file.path, snapshot.source + ".copy"); renameSync(snapshot.source + ".copy", snapshot.source);
  }
  const plugin = join(f.root, "managed-cua-fixture");
  mkdirSync(join(plugin, "node_modules"), { recursive: true });
  symlinkSync(join(f.serving, "current"), join(plugin, "node_modules/openclaw"));
  chmodSync(f.root, 0o755);
  const runtimeProbe = process.getuid() === 0 ? { uid: 1000, gid: 1000 } : {};
  if (process.getuid() === 0) { chownSync(plugin, 0, 1000); chmodSync(plugin, 0o750); }
  writeFileSync(join(plugin, "probe.cjs"), "if(process.getuid()!==Number(process.env.SDK_TEST_UID))process.exit(67);process.stdout.write(require('openclaw/plugin-sdk/core').candidate);");
  const sdk = () => spawnSync(process.execPath, [join(plugin, "probe.cjs")], { ...runtimeProbe,
    env: { ...f.env, SDK_TEST_UID: String(runtimeProbe.uid ?? process.getuid()) }, cwd: f.root, encoding: "utf8" });
  return { ...f, exported, manifest, candidate, plugin, sdk, sourceJournal };
}

function runImport(f, interruption = "") {
  if (!f.importCommands) {
    for (const [name, value] of Object.entries({ system: "inactive", "system-enabled": "disabled", pid: "0", "system-exec-main-pid": "0", "listener-pid": "0" }))
      writeFileSync(join(f.state, name), value);
    const systemctl = join(f.commands, "handoff-systemctl");
    writeFileSync(systemctl, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == is-enabled || "$1" == is-active ]] && [[ "$2" == openclaw-hourly-update.timer || "$2" == openclaw-nightly-update.timer ]]; then
  if [[ "$1" == is-enabled ]]; then echo disabled; else echo inactive; fi
  exit 3
fi
exec ${quote(f.commandPaths.systemctl)} "$@"
`, { mode: 0o755 });
    const realMv = spawnSync("bash", ["-c", "command -v mv"], { env: f.env, encoding: "utf8" }).stdout.trim();
    assert.ok(realMv.startsWith("/"));
    writeFileSync(join(f.commands, "mv"), `#!/usr/bin/env bash
set -euo pipefail
${quote(realMv)} "$@"
target="\${@: -1}"
if [[ "\${HANDOFF_IMPORT_TEST_INTERRUPT:-}" == previous && "$target" == ${quote(join(f.serving, "previous"))} ]] ||
   [[ "\${HANDOFF_IMPORT_TEST_INTERRUPT:-}" == current && "$target" == ${quote(join(f.serving, "current"))} ]]; then exit 73; fi
`, { mode: 0o755 });
    const preload = join(f.root, "import-publication-interrupt.mjs"), node = join(f.commands, "handoff-node");
    writeFileSync(preload, `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const link=fs.linkSync;
fs.linkSync=function(a,b){const result=link(a,b);if(b===${JSON.stringify(f.journal)}&&process.env.HANDOFF_IMPORT_TEST_INTERRUPT==='journal')process.exit(73);return result;};syncBuiltinESMExports();`);
    writeFileSync(node, `#!/usr/bin/env bash\nexec ${quote(process.execPath)} --import ${quote(preload)} "$@"\n`, { mode: 0o755 });
    Object.assign(f.env, { OPENCLAW_TEAM_SYSTEMCTL: systemctl, OPENCLAW_TEAM_NODE_BIN: node,
      OPENCLAW_TEAM_CONFIG_FILE: f.config, OPENCLAW_TEAM_STATE_DATABASE: f.shared });
    f.importCommands = true;
  }
  f.env.HANDOFF_IMPORT_TEST_INTERRUPT = interruption;
  return runOwner(f, ["--handoff-import", f.exported.manifest, f.exported.manifestSha256]);
}

test("imports one host into a disabled target and gates activation on Doctor and exact native config repairs", t => {
  const f = targetFixture(t), { exported, candidate, sourceJournal } = f;
  assert.notEqual(f.run("target-import", [exported.manifest, "0".repeat(64)]).status, 0);
  writeFileSync(join(f.root, "etc/machine-id"), "c".repeat(32) + "\n");
  assert.notEqual(f.run("target-import", [exported.manifest, exported.manifestSha256]).status, 0);
  assert.equal(existsSync(f.journal), false);
  writeFileSync(join(f.root, "etc/machine-id"), targetId + "\n");
  const target = f.success(f.run("target-import", [exported.manifest, exported.manifestSha256]));
  const targetBackup = JSON.parse(readFileSync(f.journal)).configBackup.path;
  assert.equal(lstatSync(targetBackup).uid, process.getuid());
  assert.equal(lstatSync(targetBackup).mode & 0o7777, 0o600);
  assert.deepEqual(readFileSync(targetBackup), readFileSync(f.config));
  if (process.getuid() === 0) assert.equal(lstatSync(f.config).uid, f.runtimeUid);
  assert.deepEqual(JSON.parse(readFileSync(f.journal)).schedules, f.admission.schedules);
  assert.equal(f.success(f.run("target-import", [exported.manifest, exported.manifestSha256])), target);
  f.success(runImport(f));
  assert.equal(f.success(f.sdk()), targetSha, "Doctor's managed plugin must resolve the selected candidate SDK after import");
  assert.equal(readlinkSync(join(f.plugin, "node_modules/openclaw")), join(f.serving, "current"));
  assert.equal(realpathSync(join(f.serving, "previous")), f.initial);
  assert.doesNotMatch(readFileSync(f.eventlog, "utf8"), /service\.system\.(start|stop|restart|enable|disable)/);
  assert.equal(existsSync(f.permit), false);
  assert.notEqual(f.run("target-permit").status, 0);
  f.success(f.run("target-doctor"));
  f.success(f.run("target-doctor"));
  const verifiedJournal = readFileSync(f.journal);
  f.success(runImport(f));
  assert.deepEqual(readFileSync(f.journal), verifiedJournal);
  const config = JSON.parse(readFileSync(f.config)), fromRoot = config.worktreeRoot;
  delete config.worktreeRoot; config.models.providers["fixture-provider"].baseUrl = "https://gateway.example.invalid";
  writeFileSync(f.config + ".native", JSON.stringify(config), { mode: 0o600 }); renameSync(f.config + ".native", f.config);
  const hash = createHash("sha256").update(readFileSync(f.config)).digest("hex");
  assert.notEqual(f.run("target-ready", ["0".repeat(64)]).status, 0);
  assert.notEqual(f.run("target-ready", [hash]).status, 0);
  const db = new DatabaseSync(f.shared);
  db.prepare("INSERT INTO migration_runs VALUES(?,?,?)").run("worktree-root-relocation:fixture", "completed", JSON.stringify({ kind: "worktree-root-relocation", fromRoot, toRoot: join(f.runtime, ".openclaw/worktrees") }));
  db.close();
  const unexpected = { ...config, extraUserConfig: "not approved" };
  writeFileSync(f.config, JSON.stringify(unexpected), { mode: 0o600 });
  const unexpectedHash = createHash("sha256").update(readFileSync(f.config)).digest("hex");
  assert.match(f.run("target-ready", [unexpectedHash]).stderr, /changes beyond/);
  writeFileSync(f.config, JSON.stringify(config), { mode: 0o600 });
  f.success(f.run("target-ready", [hash]));
  assert.equal(existsSync(f.permit), false);
  f.success(f.run("target-permit"));
  assert.equal(existsSync(f.permit), true);
  // A failed systemd start retries its owned permit, without repeating import or Doctor.
  f.success(f.run("target-permit"));
  assert.equal(f.success(f.run("status")), "TARGET_VERIFYING");
  const completed = join(f.serving, "journal", JSON.parse(readFileSync(f.journal)).stage, "completed.json");
  const interrupt = join(f.root, "interrupt-completion.mjs");
  writeFileSync(interrupt, `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const unlink=fs.unlinkSync;fs.unlinkSync=function(file){if(file.startsWith(${JSON.stringify(completed + ".next.")}))process.exit(73);return unlink(file);};syncBuiltinESMExports();`);
  assert.equal(f.run("target-finish", [], undefined, interrupt).status, 73);
  assert.equal(lstatSync(completed).nlink, 2);
  assert.equal(existsSync(f.journal), true);
  f.success(spawnSync(process.execPath, [library, "migration-publication-recover", f.serving], { env: f.env, encoding: "utf8" }));
  assert.equal(lstatSync(completed).nlink, 1);
  f.success(f.run("target-finish"));
  assert.equal(existsSync(f.journal), false);
  assert.deepEqual(readFileSync(join(f.root, "original-source-journal.json")), sourceJournal);
});

for (const interruption of ["journal", "previous", "current"]) {
  test(`import resumes after ${interruption} publication with the same journal and candidate SDK`, t => {
    const f = targetFixture(t);
    const stopped = runImport(f, interruption);
    // Pointer publication reports the injected mv failure through the owner's error path.
    assert.equal(stopped.status, interruption === "journal" ? 73 : 1, stopped.stderr);
    assert.equal(existsSync(f.permit), false);
    const original = readFileSync(f.journal);
    const pointers = ["previous", "current"].map(name => lstatSync(join(f.serving, name), { throwIfNoEntry: false }));
    if (interruption !== "current") assert.notEqual(f.run("target-doctor").status, 0);
    const resumed = runImport(f);
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.match(resumed.stdout, /HANDOFF_IMPORTED.*candidate-selected=true start-permit=absent/);
    assert.deepEqual(readFileSync(f.journal), original);
    assert.equal(f.success(f.sdk()), targetSha);
    for (const [index, name] of ["previous", "current"].entries()) {
      if (pointers[index]) assert.equal(lstatSync(join(f.serving, name)).ino, pointers[index].ino);
    }
    assert.equal(existsSync(f.permit), false);
  });
}

for (const fault of ["current-without-previous", "foreign-current", "foreign-previous", "permit-present"]) {
  test(`import refuses ${fault} without replacing the observed namespace`, t => {
    const f = targetFixture(t);
    assert.equal(runImport(f, "journal").status, 73);
    if (fault === "current-without-previous") symlinkSync(f.candidate, join(f.serving, "current"));
    if (fault === "foreign-current") {
      symlinkSync(f.initial, join(f.serving, "previous"));
      symlinkSync(f.initial, join(f.serving, "current"));
    }
    if (fault === "foreign-previous") symlinkSync(f.candidate, join(f.serving, "previous"));
    if (fault === "permit-present") writeFileSync(f.permit, '{"version":1,"purpose":"gateway-start-permit"}\n', { mode: 0o600 });
    const before = ["previous", "current"].map(name => lstatSync(join(f.serving, name), { throwIfNoEntry: false })?.ino);
    const journal = readFileSync(f.journal);
    const refused = runImport(f);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, fault === "permit-present" ? /permit/i : fault === "current-without-previous" ? /valid imported publication prefix/ : /pointer identity changed/);
    assert.deepEqual(["previous", "current"].map(name => lstatSync(join(f.serving, name), { throwIfNoEntry: false })?.ino), before);
    assert.deepEqual(readFileSync(f.journal), journal);
  });
}
