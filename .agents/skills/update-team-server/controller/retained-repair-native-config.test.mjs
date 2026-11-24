import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, chownSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ready, build, transaction, lifecycle, lease, status } from "./retained-repair-lifecycle-test-support.mjs";
import { reconcileConfig, replace } from "./retained-repair-test-support.mjs";

const unit = "openclaw-gateway.service", fragment = "/etc/systemd/system/" + unit;
const library = "/usr/local/lib/openclaw-team/release-lib.mjs";
const names = ["openclaw-release-deploy", "release-lib.mjs", "gateway-suspension-contract.mjs", "startup-profile.mjs"];
const run = (command, args, options = {}) => spawnSync(command, args, { encoding: "utf8", timeout: 30000, ...options });
function checked(command, args) {
  const result = run(command, args);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return result.stdout.trim();
}
const ctl = (...args) => checked("/usr/bin/systemctl", args);
function resume(f, journal) {
  return run("bash", ["-c", 'exec 9<>"$OPENCLAW_TEAM_LOCK_FILE"; flock -n 9 || exit 75; exec "$@"', "native-resume",
    process.execPath, library, "retained-repair-entry", "resume", f.serving, f.request.operation, journal.sha256], { env: f.env });
}

// Exercise the actual activation-shell consumer against the real inspect/fingerprint owners.
function shellContext(f, journal) {
  const source = readFileSync(join(import.meta.dirname, "openclaw-release-deploy"), "utf8");
  const functions = [...source.matchAll(/^([A-Za-z_][A-Za-z_0-9]*)\(\) \{/gm)];
  const exact = name => {
    const index = functions.findIndex(match => match[1] === name); assert(index >= 0, name);
    return source.slice(functions[index].index, functions[index + 1]?.index ?? source.length);
  };
  const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
  const script = ["set -Eeuo pipefail", "node_bin=" + quote(process.execPath), "serving_root=" + quote(f.serving),
    'releases_root="$serving_root/releases"', "repair_journal=" + quote(JSON.stringify(journal)),
    "config_file=" + quote(f.config), "state_database=" + quote(f.databasePath), 'reconcile_evidence=""',
    'fail(){ printf "%s\\n" "$*" >&2; return 1; }',
    "proof(){ \"$node_bin\" --no-warnings " + quote(library) + " \"$@\"; }",
    ...["repair_value", "repair_load_context", "assert_protected_identity"].map(exact),
    "repair_load_context", "assert_protected_identity"].join("\n");
  return run("bash", ["-c", 'exec 9<>"$OPENCLAW_TEAM_LOCK_FILE"; flock -n 9 || exit 75; exec bash -c "$1"',
    "native-shell-context", script], { env: f.env });
}

// Explicit opt-in: this proof owns a disposable container's canonical unit and installed closure.
// Ordinary test runs must never create services on an operator's systemd host.
test("reviewed retained config crosses the installed native systemd start condition", {
  skip: process.env.OPENCLAW_CONTROLLER_NATIVE_PROOF !== "1" && "requires explicitly disposable systemd container",
}, async t => {
  assert.equal(process.platform, "linux");
  assert.equal(process.getuid(), 0);
  assert.equal(readFileSync("/proc/1/comm", "utf8").trim(), "systemd");
  assert.equal(readFileSync("/run/systemd/container", "utf8").trim(), "docker");
  assert.equal(readFileSync("/run/openclaw-controller-disposable-proof", "utf8").trim(), "retained-repair-config");
  assert.equal(ctl("show", unit, "--property=LoadState", "--value"), "not-found");
  assert(!existsSync(fragment) && !existsSync(fragment + ".d"), "refuse an existing Gateway unit");
  for (const name of names) {
    const destination = name === names[0] ? "/usr/local/sbin/" + name : "/usr/local/lib/openclaw-team/" + name;
    assert(!existsSync(destination), "refuse an existing controller closure");
  }
  mkdirSync("/usr/local/lib/openclaw-team", { recursive: true, mode: 0o755 });
  chmodSync("/usr/local/lib/openclaw-team", 0o755);
  for (const name of names) {
    const destination = name === names[0] ? "/usr/local/sbin/" + name : "/usr/local/lib/openclaw-team/" + name;
    copyFileSync(join(import.meta.dirname, name), destination);
    chownSync(destination, 0, 0);
    chmodSync(destination, name === names[0] ? 0o755 : 0o644);
  }
  t.after(() => {
    for (const name of names) rmSync(name === names[0] ? "/usr/local/sbin/" + name : "/usr/local/lib/openclaw-team/" + name);
  });
  for (const tampered of [false, true]) await t.test(tampered ? "late replacement refuses resume and native execution" : "reviewed replacement starts target, preserving mandatory acceptance", () => {
    const cleanup = [], f = ready({ after: fn => cleanup.push(fn), diagnostic: message => t.diagnostic(message) });
    try {
      f.library = library;
      Object.assign(f.env, { PATH: "/usr/local/bin:/usr/bin:/bin", OPENCLAW_TEAM_RELEASE_LIB: library,
        OPENCLAW_TEAM_DEPLOY_EXECUTABLE: "/usr/local/sbin/openclaw-release-deploy", OPENCLAW_TEAM_ANCESTOR_BOUNDARY: "/",
        OPENCLAW_TEAM_PROC_ROOT: "/proc", OPENCLAW_TEAM_SYSTEMCTL: "/usr/bin/systemctl", OPENCLAW_TEAM_BUSCTL: "/usr/bin/busctl", OPENCLAW_TEAM_SS: "/usr/bin/ss" });
      // Only the application is synthetic. PID1, process generation, cgroup, listener,
      // installed ExecCondition, controller artifacts and all native guards are real.
      for (const release of [f.b, f.c]) {
        const file = join(release, "dist/index.js"); chmodSync(file, 0o755);
        writeFileSync(file, "const http=require('node:http');process.title='openclaw-gateway';http.createServer((q,s)=>{s.writeHead(503);s.end('synthetic readiness refusal');}).listen(18789,'127.0.0.1');\n");
        chmodSync(file, 0o555);
      }
      writeFileSync(fragment, `[Unit]\nDescription=Synthetic retained repair proof\n[Service]\nType=simple\nUser=root\nWorkingDirectory=${f.serving}/current\nExecStart=/usr/bin/node ${f.serving}/current/dist/index.js gateway --port 18789\nRestart=always\nKillMode=control-group\n[Install]\nWantedBy=multi-user.target\n`, { mode: 0o644 });
      ctl("daemon-reload"); ctl("enable", unit); ctl("start", unit);
      f.pid = Number(ctl("show", unit, "--property=MainPID", "--value"));
      const stat = readFileSync(`/proc/${f.pid}/stat`, "utf8");
      f.start = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/)[19];
      f.request.process = { pid: f.pid, generation: f.start };
      const configSha256 = reconcileConfig(f);
      f.request = build(f, "request", { operation: f.request.operation, target: f.request.target.sha, current: f.record.candidate.sha,
        pid: f.pid, generation: f.start, journalSha256: f.request.source.sha256, configSha256 });
      build(f, "begin", f.request); build(f, "origin"); const completed = build(f, "finish");
      let current = transaction(f, "begin", completed.completed); current = transaction(f, "verify", current.journal);
      const beforeBind = shellContext(f, current.journal);
      assert.equal(beforeBind.status, 0, beforeBind.stderr);
      current = lifecycle(f, "bind", current, { instance: "synthetic-native-service" });
      const response = lease(); current = lifecycle(f, "suspend", current, { response });
      current = lifecycle(f, "stop-intent", current, { response: status(response), suspensionId: response.suspensionId });
      ctl("stop", unit); current = lifecycle(f, "stopped", current); current = lifecycle(f, "select-intent", current);
      current = lifecycle(f, "select", current); current = lifecycle(f, "start-intent", current, { verificationSeconds: 600 });
      const before = readFileSync(f.journal);
      if (tampered) replace(f.config, readFileSync(f.config, "utf8") + " ");
      const resumedContext = shellContext(f, current.journal);
      assert.equal(resumedContext.status === 0, !tampered, resumedContext.stderr);
      const resumed = resume(f, current.journal);
      assert.equal(resumed.status === 0, !tampered, resumed.stderr);
      if (tampered) assert.match(resumed.stderr, /repair configuration/);
      else assert.equal(JSON.parse(resumed.stdout).journal.sha256, current.journal.sha256);
      assert.deepEqual(readFileSync(f.journal), before, "resume preserves canonical intent");
      if (!tampered) assert.equal(lifecycle(f, "start-dispatch", current).phase, "DISPATCH_ONCE");
      // Even direct systemd dispatch cannot escape the final config identity check.
      const started = run("/usr/bin/systemctl", ["start", unit]);
      const mainPid = Number(ctl("show", unit, "--property=MainPID", "--value"));
      const condition = ctl("show", unit, "--property=ExecCondition", "--value");
      assert.equal(existsSync(f.prefix + ".start-claim.json"), !tampered);
      if (tampered) {
        assert.equal(mainPid, 0);
        assert.match(checked("/usr/bin/journalctl", ["-u", unit, "--no-pager", "-n", "10", "-o", "cat"]), /repair claim config changed/);
      } else {
        assert.equal(started.status, 0, started.stderr); assert(mainPid > 0);
        assert.match(condition, /code=exited ; status=0/);
        current = lifecycle(f, "started", current, { instance: "synthetic-successor-service" });
        assert.equal(current.record.phase, "REPAIR_STARTED");
        const premature = run("bash", ["-c", 'exec 9<>"$OPENCLAW_TEAM_LOCK_FILE"; flock -n 9 || exit 75; exec "$@"', "native-complete",
          process.execPath, library, "retained-repair-lifecycle", "complete", f.serving, JSON.stringify({ journal: current.journal })], { env: f.env });
        assert.notEqual(premature.status, 0, "native start is not target acceptance");
        assert.equal(checked("/usr/bin/curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "http://127.0.0.1:18789/readyz"]), "503");
      }
      assert.deepEqual(readFileSync(JSON.parse(readFileSync(completed.completed.path)).original.path), f.original);
      t.diagnostic(JSON.stringify({ tampered, configSha256, condition, mainPid, phase: current.record.phase }));
    } finally {
      ctl("stop", unit); ctl("disable", unit);
      rmSync(fragment); rmSync(fragment + ".d", { recursive: true, force: true }); ctl("daemon-reload"); ctl("reset-failed");
      for (const fn of cleanup.reverse()) fn();
    }
  });
});
