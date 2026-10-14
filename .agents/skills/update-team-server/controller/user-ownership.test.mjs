import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const owner = readFileSync(process.env.TEAM_OWNER_TEST_SOURCE ?? new URL("./openclaw-release-deploy", import.meta.url), "utf8");
const library = process.env.TEAM_OWNER_TEST_LIBRARY ?? join(import.meta.dirname, "release-lib.mjs");
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const fileHelper = owner.slice(owner.indexOf("user_file_systemctl() {"), owner.indexOf("user_unit_file() {"));
const helpers = owner.slice(owner.indexOf("system_state() {"), owner.indexOf("load_gateway_runtime() {") < 0 ? owner.indexOf("read_service() {") : owner.indexOf("load_gateway_runtime() {"));
const stoppedOwners = owner.match(/^stopped_system_owners\(\) \{[\s\S]*?^\}/m)[0];
const manager = { LoadState: "loaded", ActiveState: "inactive", SubState: "dead", MainPID: "0", ControlPID: "0", Job: "", ControlGroup: "" };

// Exercise the maintained admission boundary against native command outcomes.
// Unlike a boolean mock, unavailable D-Bus and offline disabled are distinct exits.
function admission(t, change = {}, topology = "system") {
  const root = mkdtempSync(join(tmpdir(), "team-user-owner-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = { system: "active", user: "", userExit: 1, enabled: "disabled", manager, ...change };
  const systemctl = join(root, "systemctl");
  writeFileSync(systemctl, `#!${process.execPath}\nconst f=${JSON.stringify(fixture)};
const fs=require("node:fs");
const args=process.argv.slice(2), user=args.includes('--user'), offline=args.includes('--root=/');
if(args.includes('show')) {
 if(args.includes('openclaw-gateway.service')) {
  if(user&&!f.user)process.exit(f.userExit);
  const fields=user?{MainPID:f.userMainPID??'0',ControlPID:'0',Job:'0'}:
    {ActiveState:f.system,SubState:'dead',MainPID:'0',ControlPID:'0',Job:'0'};
  for(const [key,value] of Object.entries(fields))process.stdout.write(key+'='+value+'\\n');
  process.exit(0);
 }
 if(f.managerExit) process.exit(f.managerExit);
 if(f.managerChanges || f.managerRecheckFails) { const counter=__filename+'.reads'; const second=fs.existsSync(counter); if(second&&f.managerChanges) f.manager.ActiveState='active'; if(second&&f.managerRecheckFails) process.exitCode=1; fs.writeFileSync(counter,'1'); }
 if(!args.includes('user@1000.service')) process.exit(64);
 if(f.managerRaw !== undefined) process.stdout.write(f.managerRaw);
 else for(const [key,value] of Object.entries(f.manager)) process.stdout.write(key+'='+value+'\\n');
} else if(args.includes('is-active')) {
 process.stdout.write(user?f.user:f.system); process.exit(user?f.userExit:f.system==='active'?0:3);
} else if(args.includes('is-enabled')) {
 if(user&&!offline) { process.stdout.write(f.user ? f.enabled : ''); process.exit(f.user?f.enabled==='enabled'?0:1:1); }
 process.stdout.write(user?f.enabled:f.systemEnabled??'enabled'); process.exit(user?f.enabled==='enabled'?0:1:0);
} else process.exit(64);
`, { mode: 0o755 });
  for (const relative of ["sys", "sys/fs", "sys/fs/cgroup", "sys/fs/cgroup/user.slice", "sys/fs/cgroup/user.slice/user-1000.slice"])
    mkdirSync(join(root, relative));
  if (change.events !== undefined) {
    const group = join(root, "sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service");
    mkdirSync(group);
    writeFileSync(join(group, "cgroup.events"), change.events);
  }
  const program = `set -euo pipefail
systemctl_bin=${quote(systemctl)}
node_bin=${quote(process.execPath)}
runtime_uid=1000
runtime_home=${quote(root)}
runtime_dir=${quote(join(root, 'run/user/1000'))}
bus_address="unix:path=$runtime_dir/bus"
ancestor_boundary=${quote(root)}
ss_bin=/usr/bin/true; gateway_port=18789
run_runtime() { "$@"; }
user_systemctl() { run_runtime "$systemctl_bin" --user "$@"; }
system_systemctl() { "$systemctl_bin" "$@"; }
proof() { "$node_bin" --no-warnings ${quote(library)} "$@"; }
fail() { printf '%s\\n' "$*" >&2; return 1; }
${fileHelper}
${helpers}
${stoppedOwners}
if ${topology === "stopped" ? "stopped_system_owners" : `assert_exclusive_owner ${quote(topology)}`}; then printf ADMITTED; else exit 1; fi
`;
  const result = spawnSync("bash", ["-c", program], { encoding: "utf8", timeout: 10_000,
    env: { ...process.env, OPENCLAW_TEAM_ROOT_UID: String(process.getuid()), OPENCLAW_TEAM_ROOT_GID: String(process.getgid()) } });
  assert.ifError(result.error);
  return result;
}

test("disabled legacy user unit with a positively stopped manager admits the system owner without a user bus", t => {
  const result = admission(t);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "ADMITTED");
});

test("stopped system recovery accepts an absent user bus only with stopped-manager proof", t => {
  const result = admission(t, { system: "inactive" }, "stopped");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "ADMITTED");
  for (const change of [
    { manager: { ...manager, MainPID: "42" } },
    { managerChanges: true },
    { events: "populated 1\nfrozen 0\n" },
    { user: "inactive", userExit: 3, userMainPID: "42" },
  ]) assert.notEqual(admission(t, { system: "inactive", ...change }, "stopped").status, 0);
});

test("unavailable user bus does not hide a running or uncertain user manager", async t => {
  for (const mutation of [
    { ActiveState: "active", SubState: "running", MainPID: "42" },
    { ActiveState: "activating", SubState: "start" },
    { MainPID: "42" }, { ControlPID: "43" }, { Job: "17" },
    { LoadState: "error" }, { SubState: "stop-sigterm" },
  ]) await t.test(JSON.stringify(mutation), t => assert.notEqual(admission(t, { manager: { ...manager, ...mutation } }).status, 0));
});

for (const [name, change] of [
  ["manager command error", { managerExit: 1 }],
  ["manager changes during cgroup observation", { managerChanges: true }],
  ["failed recheck with identical output", { managerRecheckFails: true }],
  ["malformed user output", { user: "inactive\nactive", userExit: 3 }],
  ["empty successful user query", { user: "", userExit: 0 }],
  ["noncanonical manager group", { manager: { ...manager, ControlGroup: "/elsewhere" } }],
  ["space-only manager group", { manager: { ...manager, ControlGroup: " " } }],
  ["missing manager fields", { managerRaw: "ActiveState=inactive\n" }],
  ["duplicate manager fields", { managerRaw: Object.entries(manager).map(([k,v]) => `${k}=${v}\n`).join('') + "MainPID=0\n" }],
  ["populated manager descendants", { events: "populated 1\nfrozen 0\n" }],
  ["malformed cgroup state", { events: "populated unknown\n" }],
  ["still enabled legacy unit", { enabled: "enabled" }],
  ["missing legacy unit", { enabled: "not-found" }],
  ["malformed enablement", { enabled: "disabled\nenabled" }],
  ["active legacy Gateway", { user: "active", userExit: 0 }],
]) test(`${name} refuses system ownership`, t => assert.notEqual(admission(t, change).status, 0));

test("normal live-bus inactive legacy Gateway still admits system ownership", t => {
  assert.equal(admission(t, { user: "inactive", userExit: 3 }).status, 0);
});

test("migration still requires an observed active legacy Gateway", t => {
  assert.equal(admission(t, { system: "inactive", systemEnabled: "disabled", user: "active", userExit: 0, enabled: "enabled" }, "migration-user").status, 0);
  assert.notEqual(admission(t, { system: "inactive", systemEnabled: "disabled" }, "migration-user").status, 0);
});

test("quiescent migration requires proven inactive owners, not a failed bus call", t => {
  assert.equal(admission(t, { system: "inactive" }, "quiescent").status, 0);
  assert.notEqual(admission(t, { system: "inactive", managerExit: 1 }, "quiescent").status, 0);
});

test("a stopped manager with an explicitly empty cgroup admits, without discarding descendants", t => {
  assert.equal(admission(t, { events: "populated 0\nfrozen 0\n", manager: { ...manager, Job: "0", ControlGroup: "/user.slice/user-1000.slice/user@1000.service" } }).status, 0);
});
