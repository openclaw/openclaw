import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { descriptor, lease, lifecycle, prepared, ready, refuse, test, toStartIntent } from "./retained-repair-lifecycle-test-support.mjs";

// Invoke the public action with its real argument shape and real deployment flock.
// No production-function extraction, journal-reader replacement or procfs admission bypass.
function runtime(f, action, values = [], { lock = true } = {}) {
  return spawnSync("bash", ["-c", lock ? 'exec 9<>"$OPENCLAW_TEAM_LOCK_FILE"; flock -n 9 || exit 75; exec "$@"' : 'exec "$@"',
    "runtime-public-action", process.execPath, "--no-warnings", "--import", f.preload, f.library,
    "gateway-runtime", action, f.serving, ...values.map(v => typeof v === "string" ? v : JSON.stringify(v))],
    { env: f.env, encoding: "utf8", timeout: 30000 });
}
function success(result) { assert.equal(result.status, 0, result.stderr); return result.stdout.startsWith("{") ? JSON.parse(result.stdout) : result.stdout.trim(); }
function current(f) { return success(runtime(f, "current")); }
function processCheck(f, selection, pid = f.newPid ?? f.pid, options) {
  return runtime(f, "process", [selection, join(f.root, "proc"), String(pid)], options);
}
function executable(f, pid, value) {
  const path = join(f.root, "proc", String(pid), "exe"); unlinkSync(path); symlinkSync(value, path);
  const argvPath = join(f.root, "proc", String(pid), "cmdline"), argv = readFileSync(argvPath, "utf8").split(String.fromCharCode(0));
  argv[0] = value; writeFileSync(argvPath, argv.join(String.fromCharCode(0)));
}
function saveJson(path, value) { writeFileSync(path, JSON.stringify(value) + String.fromCharCode(10), { mode: 0o600 }); }
function started(f) {
  const intent = toStartIntent(f);
  // Downstream reader fixture only: a synthetic native claim receipt, matching the
  // public native gate's closed contract. This does not invoke/bypass that gate or
  // claim native start authorization. Production lifecycle writes all v2 state.
  const start = intent.record.lifecycle.startIntent;
  saveJson(f.prefix + ".start-claim.json", { version: 1, kind: "retained-repair-start-claim",
    operation: intent.record.operation, intent: intent.journal, capability: start.capability, permit: start.permit });
  f.startSuccessor();
  if (f.managedExecutable) executable(f, f.newPid, f.managedExecutable);
  return lifecycle(f, "started", intent, { instance: "fixture-successor-instance" });
}
function managed(f) {
  // Only executable identity is tested; this copied protected binary is never run.
  f.managedExecutable = join(f.root, "managed-runtime"); copyFileSync("/bin/true", f.managedExecutable); chmodSync(f.managedExecutable, 0o755);
  const selected = success(runtime(f, "target", ["node", f.managedExecutable, descriptor(f.managedExecutable).sha256]));
  const body = ["# OpenClaw Team Gateway runtime: node", "# SHA-256: " + selected.binary.sha256,
    "[Service]", "ExecStart=", "ExecStart=" + selected.executable + " " + f.serving + "/current/dist/index.js gateway --port 18789", ""].join(String.fromCharCode(10));
  writeFileSync(f.runtimeDrop, body, { mode: 0o644 });
  f.native.start.data[0][0] = f.managedExecutable;
  f.native.start.data[0][1][0] = f.managedExecutable;
  f.native.unit.DropInPaths = [f.guard, f.runtimeDrop].sort().join(" "); f.saveNative();
  executable(f, f.pid, f.managedExecutable);
  return current(f);
}
function refused(result, pattern) {
  assert.notEqual(result.status, 0, result.stdout);
  if (pattern) assert.match(result.stderr, pattern);
}

test("retained lifecycle accepts a renamed Node process and checks systemd's launch command", t => {
  const renamed = spawnSync(process.execPath, ["-e", `
    const fs=require("node:fs"), before=fs.readFileSync("/proc/self/cmdline");
    const argv=process.argv.slice(), executable=fs.realpathSync("/proc/self/exe"), cwd=process.cwd();
    process.title="openclaw-gateway";
    process.stdout.write(JSON.stringify({before:before.toString("base64"),after:fs.readFileSync("/proc/self/cmdline").toString("base64"),
      unchanged:JSON.stringify(argv)===JSON.stringify(process.argv)&&executable===fs.realpathSync("/proc/self/exe")&&cwd===process.cwd()}));
  `], { encoding: "utf8" });
  assert.equal(renamed.status, 0, renamed.stderr);
  const observed = JSON.parse(renamed.stdout), cmdline = Buffer.from(observed.after, "base64");
  assert.equal(observed.unchanged, true);
  assert.notEqual(observed.before, observed.after);
  assert.equal(cmdline.toString().split("\0")[0], "openclaw-gateway");
  const f = ready(t), state = prepared(f);
  writeFileSync(join(f.root, "proc", String(f.pid), "cmdline"), cmdline);
  const bound = lifecycle(f, "bind", state, { instance: "fixture-original-instance" });
  assert.equal(bound.record.phase, "REPAIR_BOUND");
  for (const argv of [
    [process.execPath, "/unrelated/script.js", "gateway", "--port", "18789"],
    [process.execPath, join(f.serving, "current/dist/index.js"), "gateway", "--port", "9999"],
  ]) {
    f.refreshNative();
    f.native.start.data[0][1] = argv;
    f.saveNative();
    refuse(f, "suspend", bound, { response: lease() }, /launch command/);
  }
});

test("public runtime process accepts exact STARTED v2 default Node, preserving strict retained ownership", async t => {
  const f = ready(t), state = started(f), selection = current(f);
  assert.equal(state.record.phase, "REPAIR_STARTED"); assert.equal(selection.binary, null); assert.equal(selection.dropIn, null);
  assert.deepEqual(success(runtime(f, "check", [selection])), selection);
  const before = readFileSync(f.journal), calls = readFileSync(f.nativeCalls);
  await t.test("exact public process action accepts the native-shaped default runtime", () => {
    assert.equal(success(processCheck(f, selection)), "RUNTIME_PROCESS_BOUND");
    assert.deepEqual(readFileSync(f.journal), before); assert.deepEqual(readFileSync(f.nativeCalls), calls);
  });
  await t.test("retained default Node binds the original executable, not a truthy flag", () => {
    executable(f, f.newPid, "/bin/false");
    refused(processCheck(f, selection), /process is not using the selected executable/);
    executable(f, f.newPid, process.execPath);
  });
  await t.test("strict v2 shape rejects unknown fields", () => {
    saveJson(f.journal, { ...state.record, runtimeChange: true });
    refused(processCheck(f, selection), /unknown|unexpected|fields|shape|malformed/);
    writeFileSync(f.journal, before);
  });
  for (const [name, path] of [
    ["completed build descriptor", state.record.build.path],
    ["native lifecycle receipt", f.prefix + ".lifecycle-started.json"],
    ["durable transition chain", f.prefix + ".transition-9.json"],
  ]) await t.test("v2 reader rejects changed " + name, () => {
    const bytes = readFileSync(path), value = JSON.parse(bytes);
    if (name === "native lifecycle receipt") value.instance = "different-instance";
    else if (name === "durable transition chain") value.next.operation = "different-operation";
    else value.operation = "different-operation";
    saveJson(path, value);
    try { refused(processCheck(f, selection), /changed|differs|invalid/); } finally { writeFileSync(path, bytes); }
  });
  await t.test("retained reader requires the real held lock", () => {
    refused(processCheck(f, selection, f.newPid, { lock: false }), /lock/);
  });
  await t.test("selected-runtime drift fails before ownership acceptance", () => {
    refused(processCheck(f, { ...selection, executable: "/bin/false" }), /runtime changed/);
  });
  assert.deepEqual(readFileSync(f.journal), before);
});

test("public runtime process validates managed-runtime v2 custody too", t => {
  const f = ready(t), selection = managed(f);
  f.record.gatewayRuntime = selection; saveJson(f.journal, f.record); f.request.source = descriptor(f.journal);
  const state = started(f);
  assert.equal(success(processCheck(f, selection)), "RUNTIME_PROCESS_BOUND");
  const before = readFileSync(f.journal);
  saveJson(f.journal, { ...state.record, sequence: 8 });
  refused(processCheck(f, selection), /phase or sequence/);
  writeFileSync(f.journal, before);
  executable(f, f.newPid, "/bin/false"); refused(processCheck(f, selection), /process is not using the selected executable/);
});

test("public runtime process retains v1 default, managed, rollback and no-journal semantics", async t => {
  const f = ready(t), original = readFileSync(f.journal), node = current(f);
  assert.equal(success(processCheck(f, node)), "RUNTIME_PROCESS_BOUND");
  const selected = managed(f);
  saveJson(f.journal, { ...f.record, predecessor: f.record.candidate, gatewayRuntime: node, runtimeChange: selected });
  assert.equal(success(processCheck(f, selected)), "RUNTIME_PROCESS_BOUND");
  executable(f, f.pid, "/bin/false"); refused(processCheck(f, selected), /process is not using the selected executable/);
  // The original Node selection during v1 rollback still checks runtimeChange.
  unlinkSync(f.runtimeDrop);
  await t.test("v1 rollback to the installed default Node", { skip: !existsSync(node.executable) && "requires installed /usr/bin/node" }, () => {
    executable(f, f.pid, realpathSync(node.executable));
    assert.equal(success(processCheck(f, node)), "RUNTIME_PROCESS_BOUND");
    executable(f, f.pid, "/bin/false"); refused(processCheck(f, node), /process is not using the selected executable/);
  });
  // A malformed v1 journal must not become a v2 bypass.
  saveJson(f.journal, { ...f.record, phase: "REPAIR_STARTED" }); refused(processCheck(f, node), /malformed or ambiguous/);
  writeFileSync(f.journal, original); unlinkSync(f.journal);
  assert.equal(success(processCheck(f, node)), "RUNTIME_PROCESS_BOUND");
});
