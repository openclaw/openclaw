import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync,
  renameSync, rmSync, statfsSync, symlinkSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const base = import.meta.dirname;
export const names = ["openclaw-release-deploy", "release-lib.mjs", "gateway-suspension-contract.mjs", "startup-profile.mjs"];
export const probe = "retained-controller-test-unknown-command";
export const digest = bytes => createHash("sha256").update(bytes).digest("hex");
export function descriptor(path) {
  const s = lstatSync(path);
  return { path, device: s.dev, inode: s.ino, sha256: digest(readFileSync(path)) };
}

// No emulated procfs, namespace override, or private proc-admission preload.
// Ordinary adoption needs genuine Linux flock/fdinfo but works unprivileged.
export const linuxSkip = process.platform !== "linux" ? "requires genuine Linux /proc flock proof" :
  spawnSync("bash", ["-c", "command -v flock >/dev/null && command -v stat >/dev/null && command -v readlink >/dev/null"]).status !== 0
    ? "requires bash, flock, stat and readlink" : false;
export const bootstrapSkip = (() => {
  if (linuxSkip) return linuxSkip;
  if (process.getuid?.() !== 0 || process.geteuid?.() !== 0)
    return "full bootstrap census requires real root and the observable PID1 /proc namespace (no namespace shim)";
  try {
    if (Number(statfsSync("/proc").type) !== 0x9fa0 ||
        readlinkSync("/proc/self/ns/pid") !== readlinkSync("/proc/1/ns/pid"))
      return "full bootstrap census requires genuine /proc in PID1's namespace";
  } catch (error) { return "PID1 /proc namespace is not observable: " + error.code; }
  return false;
})();

// Deliberately synthetic, gate-free incumbent; NOT captured old production code.
// Loaded at the managed canonical path so the real /proc census must find it.
const oldLibrary = readFileSync(join(base, "retained-controller-adoption-test-old-library.mjs"));
const oldShell = Buffer.from('#!/usr/bin/env bash\nset -Eeuo pipefail\n# SYNTHETIC gate-free incumbent, not captured production.\nif [[ "${SYNTHETIC_OLD_SHELL_WAIT:-0}" == 1 ]]; then\n  printf "SYNTHETIC_READER_LOADED\\n"\n  read -r proceed\nfi\nexec "$OPENCLAW_TEAM_NODE_BIN" "$OPENCLAW_TEAM_RELEASE_LIB" journal-field "$OPENCLAW_TEAM_RELEASE_ROOT/journal/activation.json" phase\n');

export function fixture(t, { legacy = false } = {}) {
  const root = mkdtempSync(join(base, "retained-controller-adoption-test-case-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const p of ["installed", "approved", "serving", "serving/journal"])
    mkdirSync(join(root, p), { mode: p.endsWith("journal") ? 0o700 : 0o755 });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith("OPENCLAW_") && !["NODE_OPTIONS", "BASH_ENV", "ENV"].includes(key)));
  Object.assign(env, {
    OPENCLAW_TEAM_ROOT_UID: String(process.getuid()), OPENCLAW_TEAM_ROOT_GID: String(process.getgid()),
    OPENCLAW_TEAM_RUNTIME_UID: String(process.getuid()), OPENCLAW_TEAM_DEPLOY_UID: String(process.getuid()),
    OPENCLAW_TEAM_DEPLOY_GID: String(process.getgid()), OPENCLAW_TEAM_DEPLOY_FILE_UID: String(process.getuid()),
    OPENCLAW_TEAM_ANCESTOR_BOUNDARY: root, OPENCLAW_TEAM_LOCK_FILE: join(root, "deploy.lock"),
    OPENCLAW_TEAM_RELEASE_ROOT: join(root, "serving"), OPENCLAW_TEAM_RELEASE_LIB: join(root, "installed/release-lib.mjs"),
    OPENCLAW_TEAM_DEPLOY_EXECUTABLE: join(root, "installed/openclaw-release-deploy"), OPENCLAW_TEAM_NODE_BIN: process.execPath,
  });
  writeFileSync(env.OPENCLAW_TEAM_LOCK_FILE, "existing lock, never truncate or replace\n", { mode: 0o600 });
  // Approved closure is byte-for-byte active source: no injected dispatch case.
  const newBytes = names.map(n => readFileSync(join(base, n)));
  const oldBytes = legacy
    ? [oldShell, oldLibrary, Buffer.from("export const syntheticOldSuspension = true;\n"), Buffer.from("export const syntheticOldProfile = true;\n")]
    : newBytes.map((bytes, i) => Buffer.concat([bytes, Buffer.from(i ? "\n// synthetic incumbent version\n" : "\n# synthetic incumbent version\n")]));
  for (let i = 0; i < names.length; i++) {
    writeFileSync(join(root, "installed", names[i]), oldBytes[i], { mode: i ? 0o644 : 0o755 });
    writeFileSync(join(root, "approved", names[i]), newBytes[i], { mode: i ? 0o644 : 0o755 });
  }
  const record = {
    version: 1, phase: "ROLLBACK_FAILED", topology: "system",
    predecessor: { sha: "a".repeat(40), schemaVersions: { state: 21, agent: 11 } },
    candidate: { sha: "b".repeat(40), schemaVersions: { state: 21, agent: 11 } },
    process: { pid: 123, generation: "456", instance: "synthetic-incumbent" },
    pointerTopology: { current: { present: true, sha: "a".repeat(40) }, previous: { present: false, sha: null } },
    services: { system: { unitFileState: "enabled", activeState: "active" }, user: { unitFileState: "disabled", activeState: "inactive" } },
    suspension: { id: "synthetic-suspension", expiresAtMs: 1, terminalPolicy: "preserve", status: "ready" },
    protectedPaths: [{ path: join(root, "config"), device: 1, inode: 1 }, { path: join(root, "database"), device: 1, inode: 2 }],
    originalWitness: { name: "original-11111111-1111-4111-8111-111111111111.json", device: 1, inode: 3, sha256: "1".repeat(64) },
  };
  writeFileSync(join(root, "serving/journal/activation.json"), JSON.stringify(record) + "\n", { mode: 0o600 });
  writeFileSync(join(root, "config"), "config must stay unchanged\n", { mode: 0o600 });
  writeFileSync(join(root, "database"), "database must stay unchanged\n", { mode: 0o600 });
  symlinkSync("releases/" + "b".repeat(40), join(root, "serving/current"));
  symlinkSync("releases/" + "a".repeat(40), join(root, "serving/previous"));
  const request = { version: 1, operation: randomUUID(), source: descriptor(join(root, "serving/journal/activation.json")),
    oldClosure: names.map(n => descriptor(join(root, "installed", n))), replacement: names.map(n => descriptor(join(root, "approved", n))) };
  const prefix = join(root, "serving/journal/repair-" + request.operation + ".adoption");
  const protectedNames = ["config", "database", "deploy.lock", "serving/journal/activation.json"];
  return { root, env, request, oldBytes, newBytes, record, prefix, bootstrapPrefix: prefix + ".bootstrap",
    gate: join(root, "serving/journal/controller-adoption.json"), bootstrapGate: join(root, "serving/journal/controller-bootstrap.json"),
    runner: join(root, "approved/release-lib.mjs"), protectedNames,
    protectedBefore: protectedNames.map(n => descriptor(join(root, n))),
    pointersBefore: ["current", "previous"].map(n => readlinkSync(join(root, "serving", n))),
  };
}

export function call(f, action, input, { lock = "exclusive", preload, runner = f.runner } = {}) {
  const shell = lock === "none" ? 'exec "$@"' : lock === "unlocked" ? 'exec 9<>"$OPENCLAW_TEAM_LOCK_FILE"; exec "$@"' :
    lock === "shared" ? 'exec 9<>"$OPENCLAW_TEAM_LOCK_FILE"; flock -sn 9 || exit 75; exec "$@"' :
    'exec 9<>"$OPENCLAW_TEAM_LOCK_FILE"; flock -n 9 || exit 75; exec "$@"';
  return spawnSync("bash", ["-c", shell, "adoption-test", process.execPath, "--no-warnings",
    ...(preload ? ["--import", preload] : []), runner, "retained-controller-adoption", action, f.env.OPENCLAW_TEAM_RELEASE_ROOT, "@stdin"],
  { env: f.env, input: JSON.stringify(input), encoding: "utf8", timeout: 15000 });
}
export function ok(result) {
  assert.ifError(result.error); assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
}
export function denied(result, pattern) {
  assert.ifError(result.error); assert.equal(result.signal, null, result.stderr);
  assert.notEqual(result.status, 0, result.stdout); if (pattern) assert.match(result.stderr, pattern);
}
export function invoke(f, runner = f.env.OPENCLAW_TEAM_RELEASE_LIB, command = probe, args = []) {
  return spawnSync("bash", ["-c", 'exec 9<>"$OPENCLAW_TEAM_LOCK_FILE"; flock -n 9 || exit 75; exec "$@"',
    "adoption-probe", process.execPath, "--no-warnings", runner, command, ...args], { env: f.env, encoding: "utf8", timeout: 15000 });
}
export function dispatchReached(f) {
  // A known unknown command proves the unmodified library passed its gate, not success.
  denied(invoke(f), new RegExp("^openclaw-team-release: unknown release proof command: " + probe + "\\n$"));
}
export function executable(f, extraEnv = {}) {
  // Valid invocation reaches closure admission, then stops before live effects.
  const cgroup = join(f.root, "sys/fs/cgroup/system.slice/openclaw-hourly-health-check.service");
  mkdirSync(cgroup, { recursive: true, mode: 0o755 });
  writeFileSync(join(cgroup, "cgroup.events"), "populated 1\nfrozen 0\n");
  return spawnSync("bash", [f.env.OPENCLAW_TEAM_DEPLOY_EXECUTABLE],
    { env: { ...f.env, ...extraEnv }, encoding: "utf8", timeout: 15000 });
}
export function untouched(f) {
  assert.deepEqual(f.protectedNames.map(n => descriptor(join(f.root, n))), f.protectedBefore);
  assert.deepEqual(["current", "previous"].map(n => readlinkSync(join(f.root, "serving", n))), f.pointersBefore);
}
export function checkClosure(f) {
  for (let i = 0; i < names.length; i++) {
    const path = join(f.root, "installed", names[i]), s = lstatSync(path);
    assert.deepEqual(readFileSync(path), f.newBytes[i]); assert.equal(s.mode & 0o7777, i ? 0o644 : 0o755);
    assert.equal(s.uid, process.getuid()); assert.equal(s.gid, process.getgid()); assert.equal(s.nlink, 1);
  }
}
export function checkArchives(f, { bootstrap = false } = {}) {
  for (const prefix of [f.prefix, ...(bootstrap ? [f.bootstrapPrefix] : [])]) {
    assert.deepEqual(readFileSync(prefix + ".original.json"), readFileSync(f.request.source.path));
    for (let i = 0; i < names.length; i++) {
      const path = prefix + ".backup-" + i;
      assert.deepEqual(readFileSync(path), f.oldBytes[i]);
      assert.equal(lstatSync(path).mode & 0o7777, 0o600);
    }
  }
}
export function bridges(f) { return names.slice(0, 2).map(n => descriptor(join(f.root, "installed", n))); }
export function replace(path, bytes, mode) {
  const temporary = path + ".replace-" + randomUUID();
  writeFileSync(temporary, bytes, { mode }); renameSync(temporary, path);
}

// Fault injection changes ONLY publication I/O, never /proc, identity, or admission.
export function fault(f, spec) {
  const path = join(f.root, "retained-controller-adoption-test-fault-" + randomUUID() + ".mjs");
  writeFileSync(path, `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const spec = ${JSON.stringify(spec)};
let count = 0;
const rename = fs.renameSync;
fs.renameSync = function (from, to) {
  if (!String(from).includes(".adoption-") || !String(from).endsWith(".next")) return rename.apply(this, arguments);
  count++;
  if (spec.type === "rename" && spec.index === count && spec.when === "before") process.exit(86);
  const result = rename.apply(this, arguments);
  if (spec.type === "rename" && spec.index === count && spec.when === "after") process.exit(86);
  return result;
};
const link = fs.linkSync;
fs.linkSync = function (from, to) {
  const result = link.apply(this, arguments);
  if (spec.type === "link" && String(to).endsWith(spec.suffix)) process.exit(86);
  return result;
};
syncBuiltinESMExports();
`, { mode: 0o600 });
  return path;
}
export function crashed(result) { assert.ifError(result.error); assert.equal(result.signal, null); assert.equal(result.status, 86, result.stderr); }
export function closeBootstrap(f, options) {
  // Transient exiting userspace processes can have empty argv. Retry the same
  // operation only for that explicit production refusal; never forge the proof.
  let result;
  for (let attempt = 0; attempt < 10; attempt++) {
    result = call(f, "bootstrap", f.request, options);
    if (!result.stderr.includes("process command is unobservable")) break;
  }
  const closed = ok(result); assert.equal(closed.bootstrap.path, f.bootstrapPrefix + ".closed.json");
  return closed;
}
export function completeBootstrap(f, { runner = f.runner } = {}) {
  closeBootstrap(f, { runner });
  const before = bridges(f), binding = ok(call(f, "prepare", f.request, { runner }));
  const context = ok(call(f, "apply", binding, { runner }));
  for (let i = 0; i < names.length; i++) {
    const step = JSON.parse(readFileSync(f.prefix + ".step-" + i + ".json"));
    assert.deepEqual(step.from, i < 2 ? before[i] : f.request.oldClosure[i]);
  }
  checkClosure(f); checkArchives(f, { bootstrap: true }); untouched(f); return { binding, context };
}
export function managedChild(t, f, { shell = false } = {}) {
  const env = { ...f.env };
  // Pause inside the canonical old shell, not in a pre-main BASH_ENV shim.
  if (shell) env.SYNTHETIC_OLD_SHELL_WAIT = "1";
  const child = shell ? spawn("bash", [f.env.OPENCLAW_TEAM_DEPLOY_EXECUTABLE], { env, stdio: ["pipe", "pipe", "pipe"] }) :
    spawn(process.execPath, [f.env.OPENCLAW_TEAM_RELEASE_LIB, "wait-reader"], { env, stdio: ["pipe", "pipe", "pipe"] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
  });
  return child;
}
export async function waitLoaded(child) {
  const [data] = await once(child.stdout, "data"); assert.match(data.toString(), /SYNTHETIC_READER_LOADED/);
}
export async function releaseChild(child, { stopped = false } = {}) {
  const exited = once(child, "exit"); if (stopped) child.kill("SIGCONT"); child.stdin.end("continue\n"); return await exited;
}
