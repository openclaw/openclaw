import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after } from "node:test";
import { makeReleaseFixture } from "./worker-config-owner-fixture.mjs";

const library = join(import.meta.dirname, "release-lib.mjs");
const originalUmask = process.umask(0o022);
after(() => process.umask(originalUmask));

// Ordinary startup replacement uses the real journal/audit proofs without Linux services.
function startupConfigFixture(t, { phase = "ROLLBACK_FAILED", change } = {}) {
  const f = makeReleaseFixture(t), candidate = f.addRelease("b".repeat(40));
  const hash = bytes => createHash("sha256").update(bytes).digest("hex");
  const run = (cmd, args = []) => spawnSync(process.execPath, ["--no-warnings", library, cmd, ...args.map(String)],
    { env: f.env, encoding: "utf8", timeout: 30000 });
  const ok = result => { assert.ifError(result.error); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  const proof = (cmd, args = []) => ok(run(cmd, args));
  const info = [];
  for (const [release, sha] of [[f.initial, f.sha], [candidate, "b".repeat(40)]]) {
    fs.chmodSync(release, 0o755); fs.chmodSync(join(release, "node_modules"), 0o755);
    fs.mkdirSync(join(release, "node_modules/sqlite-vec"));
    fs.writeFileSync(join(release, "node_modules/sqlite-vec/index.js"), "exports.load=db=>db.function('vec_version',()=> 'fixture');");
    proof("manifest", [release, sha, process.getuid(), sha]); proof("seal-tree", [release]);
    info.push(JSON.parse(proof("validate-release", [release, sha, process.getuid(), "sealed"])));
  }
  const before = JSON.parse(fs.readFileSync(f.config));
  before.channels["nextcloud-talk"] = { accounts: { default: { enabled: true } } };
  fs.writeFileSync(f.config, JSON.stringify(before));
  const paths = JSON.parse(proof("fingerprint", [f.config, f.databasePath]));
  const previousBytes = fs.readFileSync(f.config), originalPolicy = JSON.parse(proof("policy", [f.config]));
  const witness = join(dirname(f.journal), `original-${randomUUID()}.json`);
  fs.writeFileSync(witness, "[]", { mode: 0o600 });
  const witnessStat = fs.statSync(witness);
  const record = { version: 1, phase, topology: "system", predecessor: info[0], candidate: info[1],
    createdAt: new Date(Date.now() - 60000).toISOString(),
    process: { pid: 111, generation: "1110", instance: "fixture-original" },
    protectedPaths: paths, originalWitness: { name: witness.split("/").at(-1), device: witnessStat.dev,
      inode: witnessStat.ino, sha256: hash("[]") },
    pointerTopology: { current: { present: true, sha: f.sha }, previous: { present: false, sha: null } },
    services: { system: { unitFileState: "enabled", activeState: "active" }, user: { unitFileState: "disabled", activeState: "inactive" } },
    suspension: { id: randomUUID(), expiresAtMs: Date.now() - 1000, terminalPolicy: "preserve", status: "draining" } };
  fs.writeFileSync(f.journal, JSON.stringify(record), { mode: 0o600 });
  fs.unlinkSync(join(f.serving, "current")); fs.symlinkSync(candidate, join(f.serving, "current"));
  fs.symlinkSync(f.initial, join(f.serving, "previous"));
  const processPath = join(f.env.OPENCLAW_TEAM_PROC_ROOT, "222"), binding = { pid: 222, generation: "2220" };
  fs.mkdirSync(processPath);
  const fields = Array(24).fill("0"); fields[0] = "S"; fields[19] = binding.generation;
  fs.writeFileSync(join(processPath, "stat"), `222 (fixture gateway) ${fields.join(" ")}\n`);
  fs.symlinkSync(candidate, join(processPath, "cwd"));
  const ticks = Number(spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).stdout.trim());
  fs.writeFileSync(join(f.env.OPENCLAW_TEAM_PROC_ROOT, "stat"), `btime ${Math.floor(Date.now() / 1000 - 33 - 2220 / ticks)}\n`);
  const next = structuredClone(before);
  next.meta.migrations.webhookListeners = { feishu: true, msteams: true, "nextcloud-talk": true, telegram: true };
  next.channels["nextcloud-talk"].accounts.default.legacyWebhook = { host: "127.0.0.1", port: 1234 };
  change?.(next);
  fs.copyFileSync(f.config, f.config + ".bak"); fs.chmodSync(f.config + ".bak", 0o600);
  fs.writeFileSync(f.config + ".next", JSON.stringify(next), { mode: 0o600 }); fs.renameSync(f.config + ".next", f.config);
  const entry = fs.statSync(f.config), bytes = fs.readFileSync(f.config), ts = new Date().toISOString();
  const audit = { ts, event: "config.write", source: "config-io", result: "rename", configPath: f.config,
    existsBefore: true, pid: binding.pid, previousHash: hash(previousBytes), nextHash: hash(bytes),
    previousBytes: previousBytes.length, nextBytes: bytes.length };
  for (const [prefix, descriptor] of [["previous", paths[0]], ["next", { device: entry.dev, inode: entry.ino }]])
    Object.assign(audit, { [prefix + "Dev"]: String(descriptor.device), [prefix + "Ino"]: String(descriptor.inode),
      [prefix + "Mode"]: 0o600, [prefix + "Nlink"]: 1, [prefix + "Uid"]: process.getuid(), [prefix + "Gid"]: process.getgid() });
  const db = new DatabaseSync(f.databasePath);
  db.exec("CREATE TABLE diagnostic_events(scope TEXT,event_key TEXT,sequence INTEGER,payload_json TEXT)");
  db.prepare("INSERT INTO diagnostic_events VALUES('config-audit',?,1,?)").run(`${ts}:config.write:${randomUUID()}`, JSON.stringify(audit));
  db.close();
  const request = { config: { path: f.config, sha256: hash(bytes) }, journalSha256: hash(fs.readFileSync(f.journal)),
    databasePath: f.databasePath, runtimeUid: process.getuid(), process: binding };
  const updateAudit = change => {
    const db = new DatabaseSync(f.databasePath), row = db.prepare("SELECT payload_json FROM diagnostic_events").get();
    const value = JSON.parse(row.payload_json); change(value);
    db.prepare("UPDATE diagnostic_events SET event_key=?,payload_json=?").run(`${value.ts}:config.write:fixture`, JSON.stringify(value)); db.close();
  };
  const snapshot = () => run("recovery-snapshot", [f.journal, f.serving, JSON.stringify(record), "selected", JSON.stringify(request)]);
  const accept = () => run("candidate-config-accept", [f.journal, f.serving, JSON.stringify(paths), binding.pid,
    binding.generation, request.runtimeUid, JSON.stringify(originalPolicy)]);
  return { ...f, candidate, record, paths, originalPolicy, processPath, binding, request, run, ok, proof, snapshot, accept, updateAudit };
}

function runSelectedConfigRecovery(f, { failure = "", deploy = false } = {}) {
  const source = fs.readFileSync(new URL("./openclaw-release-deploy", import.meta.url), "utf8");
  const declarations = [...source.matchAll(/^([a-zA-Z_][a-zA-Z_0-9]*)\(\) \{/gm)];
  const extract = name => { const i = declarations.findIndex(m => m[1] === name); assert.notEqual(i, -1);
    return source.slice(declarations[i].index, declarations[i + 1]?.index ?? source.length); };
  const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
  const events = join(f.root, "config-events"), script = join(f.root, "config-recovery.sh");
  fs.writeFileSync(events, "");
  fs.writeFileSync(script, `set -euo pipefail
mode=${deploy ? "deploy" : "recover"}; reconcile_stopped=0; accept_partial_nocow=0
reconcile_config_hash=${quote(deploy ? "" : f.request.config.sha256)}; reconcile_journal_hash=${quote(f.request.journalSha256)}
reconcile_request=""; reconcile_evidence=""; reconcile_position=restored; session_witness=""; session_witness_record=""
journal_file=${quote(f.journal)}; serving_root=${quote(f.serving)}; releases_root="$serving_root/releases"; current_link="$serving_root/current"
config_file=${quote(f.config)}; state_database=${quote(f.databasePath)}; proc_root=${quote(f.env.OPENCLAW_TEAM_PROC_ROOT)}
root_uid=${process.getuid()}; runtime_uid=${f.request.runtimeUid}; node_bin=${quote(process.execPath)}
operator_expected_sha=${quote(f.record.candidate.sha)}; operator_expected_pid=${f.request.process.pid}; operator_expected_generation=${quote(f.request.process.generation)}
policy_identity=${quote(JSON.stringify(f.originalPolicy))}; protected_identity=${quote(JSON.stringify(f.paths))}
candidate_release=${quote(f.candidate)}; candidate_info=${quote(JSON.stringify(f.record.candidate))}
suspension_pid=222; suspension_generation=2220
verification_budget=1
proof() {
  if [[ "$1" == compatibility ]]; then echo compatibility >>${quote(events)}; return 0; fi
  "$node_bin" --no-warnings ${quote(library)} "$@"
}
fail() { echo "$*" >&2; return 1; }
migration_check_existing_guard() { :; }
read_pointer() { readlink "$1"; }
capture_generation() { service_pid=222; service_generation=2220; }
capture_service_generation() { capture_generation; }
recheck_generation() { [[ "$*" == 'system 222 2220' ]]; }
verify_convergence() {
  verified_pid=222; verified_generation=2220
  assert_protected_identity && assert_policy || return 1
  echo probes-channels >>${quote(events)}
  [[ ${quote(failure)} != probes ]]
}
verify_marker() {
  echo marker-approvals-original-session >>${quote(events)}
  [[ "$session_witness" == '[]' || "$mode" == deploy ]] || return 1
  if [[ ${quote(failure)} == generation ]]; then sed -i.bak s/2220/9999/ "$proc_root/222/stat"; fi
  if [[ ${quote(failure)} == config ]]; then echo ' ' >>"$config_file"; fi
}
verification_failure() { echo verification-failed >&2; }
verification_step() { shift; "$@"; }
verified_markers() { echo verified-markers >>${quote(events)}; }
system_systemctl() { echo forbidden-service-action >>${quote(events)}; return 99; }
bounded() { echo forbidden-service-action >>${quote(events)}; return 99; }
${["assert_protected_identity", "assert_policy", "load_journal_witness", "wait_for_live", "recover_journal", "verify_deployed_candidate"].map(extract).join("\n")}
${deploy ? "verify_deployed_candidate" : "recover_journal"}
`);
  const result = spawnSync(f.realCommands.bash, [script], { env: f.env, encoding: "utf8", timeout: 30000 });
  assert.ifError(result.error);
  assert.doesNotMatch(fs.readFileSync(events, "utf8"), /forbidden/);
  return { ...result, events: fs.readFileSync(events, "utf8") };
}

test("failed ordinary selected candidate reconciles audited config and retires exact journal without service action", t => {
  const f = startupConfigFixture(t), original = fs.readFileSync(f.journal), result = runSelectedConfigRecovery(f);
  f.ok(result);
  assert.match(result.stdout, /RECOVERED phase=ROLLBACK_FAILED action=verified-selected-candidate-reconciled-config/);
  assert.match(result.events, /probes-channels\nmarker-approvals-original-session/);
  assert.equal(fs.existsSync(f.journal), false);
  const receipt = JSON.parse(fs.readFileSync(join(dirname(f.journal), `config-reconciliation-${f.request.journalSha256}.json`)));
  assert.deepEqual(receipt.evidence.record, JSON.parse(original));
  assert.equal(receipt.evidence.configReconciliation.journalSha256, f.request.journalSha256);
  assert.equal(receipt.evidence.configReconciliation.config.sha256, f.request.config.sha256);
  assert.ok(receipt.evidence.identity.inode);
  assert.ok(receipt.evidence.configReconciliation.replacement.audit.sha256);
  assert.equal(fs.readlinkSync(join(f.serving, "current")), f.candidate);
});

for (const [name, change] of [
  ["identical predecessor", f => { f.record.predecessor = f.record.candidate; fs.writeFileSync(f.journal, JSON.stringify(f.record)); }],
  ["wrong PID", f => { f.request.process.pid = 333; }],
  ["wrong generation", f => { f.request.process.generation = "9999"; }],
  ["changed config hash", f => { f.request.config.sha256 = "0".repeat(64); }],
  ["replaced store", f => { fs.copyFileSync(f.databasePath, f.databasePath + ".next"); fs.renameSync(f.databasePath + ".next", f.databasePath); }],
  ["candidate no longer current", f => { fs.unlinkSync(join(f.serving, "current")); fs.symlinkSync(f.initial, join(f.serving, "current")); }],
  ["missing rename audit", f => f.updateAudit(value => { value.result = "write"; })],
  ["audit preimage inode drift", f => f.updateAudit(value => { value.previousIno = "1"; })],
  ["audit preimage size drift", f => f.updateAudit(value => { value.previousBytes++; })],
]) test(`ordinary selected reconciliation refuses ${name} and retains journal`, t => {
  const f = startupConfigFixture(t); change(f); const original = fs.readFileSync(f.journal);
  const proof = f.snapshot(); assert.notEqual(proof.status, 0, proof.stdout);
  const result = runSelectedConfigRecovery(f); assert.notEqual(result.status, 0, result.stdout);
  assert.deepEqual(fs.readFileSync(f.journal), original);
  assert.equal(fs.existsSync(join(dirname(f.journal), `config-reconciliation-${f.request.journalSha256}.json`)), false);
});

for (const failure of ["probes", "generation", "config"])
test(`ordinary selected reconciliation retains original journal after ${failure} verification failure`, t => {
  const f = startupConfigFixture(t), original = fs.readFileSync(f.journal);
  assert.notEqual(runSelectedConfigRecovery(f, { failure }).status, 0);
  assert.deepEqual(fs.readFileSync(f.journal), original);
});

test("ordinary deploy accepts only audited candidate startup additions and durably rebinds config", t => {
  const f = startupConfigFixture(t, { phase: "D_VERIFYING" }), original = fs.readFileSync(f.journal);
  const result = runSelectedConfigRecovery(f, { deploy: true }); f.ok(result);
  assert.match(result.stdout, /CONFIG_MIGRATION_ACCEPTED keys=6 source=candidate-startup/);
  const record = JSON.parse(fs.readFileSync(f.journal));
  assert.equal(record.protectedPaths[0].inode, fs.statSync(f.config).ino);
  assert.deepEqual(record.protectedPaths[1], f.paths[1]);
  assert.deepEqual(record.originalWitness, f.record.originalWitness);
  const name = fs.readdirSync(dirname(f.journal)).find(name => name.startsWith("config-startup-"));
  const receipt = JSON.parse(fs.readFileSync(join(dirname(f.journal), name)));
  assert.deepEqual(receipt.original.record, JSON.parse(original));
  assert.equal(receipt.original.identity.sha256, f.request.journalSha256);
  assert.deepEqual(receipt.process, f.binding);
  f.proof("journal-read", [f.journal]);
});

for (const [name, change, mutate] of [
  ["removed key", next => { delete next.syntheticUnrelated; }],
  ["changed key", next => { next.syntheticUnrelated.retained = "changed"; }],
  ["new agent", next => { next.agents.entries.newAgent = {}; }],
  ["new plugin", next => { next.plugins.entries.newPlugin = { enabled: true }; }],
  ["new channel account", next => { next.channels["nextcloud-talk"].accounts.newAccount = { enabled: true }; }],
  ["changed policy", next => { next.agents.entries["controller-test-agent"].model.primary = "fixture/other-model"; }],
  ["foreign uid", null, f => f.updateAudit(value => { value.nextUid++; })],
  ["foreign gid", null, f => f.updateAudit(value => { value.previousGid++; })],
  ["missing rename", null, f => f.updateAudit(value => { value.result = "write"; })],
  ["another writer PID", null, f => f.updateAudit(value => { value.pid = 333; })],
  ["previous generation audit", null, f => f.updateAudit(value => { value.ts = new Date(Date.now() - 120000).toISOString(); })],
  ["missing backup", null, f => fs.unlinkSync(f.config + ".bak")],
  ["changed backup", null, f => fs.appendFileSync(f.config + ".bak", " ")],
  ["replaced store", null, f => { fs.copyFileSync(f.databasePath, f.databasePath + ".next"); fs.renameSync(f.databasePath + ".next", f.databasePath); }],
  ["reused PID", null, f => { fs.writeFileSync(join(f.processPath, "stat"), fs.readFileSync(join(f.processPath, "stat"), "utf8").replace("2220", "9999")); }],
]) test(`ordinary startup acceptance refuses ${name}`, t => {
  const f = startupConfigFixture(t, { phase: "D_VERIFYING", change }); mutate?.(f);
  const original = fs.readFileSync(f.journal), result = f.accept();
  assert.notEqual(result.status, 0, result.stdout);
  assert.deepEqual(fs.readFileSync(f.journal), original);
  assert.doesNotMatch(result.stdout, /CONFIG_MIGRATION_ACCEPTED/);
});
