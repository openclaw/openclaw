import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [packageRoot, reportPath] = process.argv.slice(2);
const runtimeRoot = process.env.OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT;
const stateDir = process.env.OPENCLAW_STATE_DIR;
assert.equal(process.env.OPENCLAW_QA_ALLOW_UPDATE_FIRST_HOP, "1");
assert.equal(runtimeRoot, "/tmp/openclaw-update-first-hop-runtime/admission-missing-load-path");
assert.equal(packageRoot, path.join(runtimeRoot, "npm-prefix/lib/node_modules/openclaw"));
assert.equal(fs.realpathSync(packageRoot), packageRoot, "Fixture package root must be direct");
assert.equal(stateDir, path.join(process.env.HOME, ".openclaw"));
assert.equal(process.env.OPENCLAW_CONFIG_PATH, path.join(stateDir, "openclaw.json"));
assert.equal(fs.realpathSync(stateDir), stateDir, "Fixture profile root must be direct");
assert(path.isAbsolute(reportPath));
assert(!reportPath.startsWith(`${stateDir}${path.sep}`));

function snapshotProfile() {
  const entries = [];
  const visit = (directory) => {
    for (const name of fs.readdirSync(directory).toSorted()) {
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      const relative = path.relative(stateDir, file);
      if (stat.isDirectory()) {
        entries.push({ path: relative, kind: "directory", mode: stat.mode });
        visit(file);
      } else if (stat.isFile()) {
        entries.push({
          path: relative,
          kind: "file",
          mode: stat.mode,
          bytes: stat.size,
          sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
        });
      } else if (stat.isSymbolicLink()) {
        entries.push({ path: relative, kind: "symlink", target: fs.readlinkSync(file) });
      } else {
        entries.push({ path: relative, kind: "special", mode: stat.mode });
      }
    }
  };
  visit(stateDir);
  return entries;
}

const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
assert.equal(manifest.openclaw?.updateAdmissionProtocol, 1);
const pendingPath = path.join(packageRoot, ".openclaw-lifecycle-pending");
assert.equal(fs.existsSync(pendingPath), false, "Refusing to replace an existing lifecycle marker");
assert.equal(fs.existsSync(path.join(packageRoot, "dist/openclaw-install-guard")), false);
const before = snapshotProfile();
const pendingBytes = Buffer.from("pending\n");
// openclaw-temp-dir: allow private protocol context outside the observed profile.
const privateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-admission-entry-probe-"));
fs.chmodSync(privateDir, 0o700);
const contextPath = path.join(privateDir, "context.json");
let markerIdentity;
let result;
let verdict;
const errors = [];
try {
  fs.writeFileSync(
    contextPath,
    JSON.stringify({
      protocol: 1,
      installation: {
        root: packageRoot,
        canonicalRoot: packageRoot,
        version: manifest.version,
        installKind: "package",
        packageManager: "npm",
        globalRoot: path.dirname(packageRoot),
      },
      target: {
        spec: packageRoot,
        version: manifest.version,
        source: "artifact",
        channel: "stable",
      },
      request: {
        yes: true,
        noRestart: true,
        acceptCapabilities: false,
        json: true,
        timeoutMs: 120_000,
        requestedChannel: null,
      },
      run: { id: randomUUID() },
      supervisor: { version: manifest.version, host: os.hostname(), pid: process.pid },
    }),
    { mode: 0o600, flag: "wx" },
  );
  assert.equal(fs.statSync(contextPath).mode & 0o777, 0o600);
  fs.writeFileSync(pendingPath, pendingBytes, { mode: 0o644, flag: "wx" });
  markerIdentity = fs.lstatSync(pendingPath);
  const env = { ...process.env };
  const omitted = new Set([
    "LAUNCH_JOB_LABEL",
    "LAUNCH_JOB_NAME",
    "XPC_SERVICE_NAME",
    "INVOCATION_ID",
    "SYSTEMD_EXEC_PID",
    "JOURNAL_STREAM",
    "OPENCLAW_COMPATIBILITY_HOST_VERSION",
    "OPENCLAW_DEV_SOURCE_ROOT",
    "OPENCLAW_BUNDLED_PLUGINS_DIR",
    "OPENCLAW_VERSION",
    "NODE_COMPILE_CACHE",
    "NODE_DISABLE_COMPILE_CACHE",
    "OPENCLAW_NO_RESPAWN",
  ]);
  for (const key of Object.keys(env)) {
    const normalized = key.toUpperCase();
    if (
      omitted.has(normalized) ||
      /^OPENCLAW_(UPDATE_|SERVICE_|SUPERVISOR_|LAUNCHD_|SYSTEMD_|WINDOWS_TASK_|CONTROL_PLANE_UPDATE_|GATEWAY_SERVICE_)/u.test(
        normalized,
      )
    ) {
      delete env[key];
    }
  }
  Object.assign(env, {
    OPENCLAW_DEV_SOURCE_ROOT: packageRoot,
    OPENCLAW_VERSION: manifest.version,
    OPENCLAW_NO_RESPAWN: "1",
    NODE_DISABLE_COMPILE_CACHE: "1",
  });
  result = spawnSync(
    process.execPath,
    [path.join(packageRoot, "dist/index.js"), "update", "admit", "--context", contextPath],
    {
      cwd: packageRoot,
      env,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
      killSignal: "SIGKILL",
      detached: true,
      windowsHide: true,
    },
  );
  fs.writeFileSync(`${reportPath}.stdout`, result.stdout ?? "", { mode: 0o600 });
  fs.writeFileSync(`${reportPath}.stderr`, result.stderr ?? "", { mode: 0o600 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, "Actual package admission entry must admit; see captured stderr");
  verdict = JSON.parse(result.stdout);
  assert.equal(verdict.protocol, 1);
  assert.equal(verdict.verdict, "admit");
  assert.deepEqual(verdict.reasons, []);
  assert.equal(verdict.facts.candidateVersion, manifest.version);
  assert(verdict.warnings.some((warning) => warning.code === "configured-plugin-path-unavailable"));
  assert(verdict.facts.checks.some((check) => check.name === "config" && check.status === "warn"));
  assert.deepEqual(
    fs.readFileSync(pendingPath),
    pendingBytes,
    "Admission consumed lifecycle marker",
  );
  assert.deepEqual(snapshotProfile(), before, "Admission changed profile artifacts");
} catch (error) {
  errors.push(error);
}
for (const cleanup of [
  () => {
    if (!result?.pid) {
      return;
    }
    try {
      process.kill(-result.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") {
        throw error;
      }
    }
  },
  () => {
    if (markerIdentity && fs.existsSync(pendingPath)) {
      const current = fs.lstatSync(pendingPath);
      if (current.dev === markerIdentity.dev && current.ino === markerIdentity.ino) {
        fs.unlinkSync(pendingPath);
      }
    }
  },
  () => fs.rmSync(privateDir, { recursive: true, force: true }),
]) {
  try {
    cleanup();
  } catch (error) {
    errors.push(error);
  }
}
if (errors.length) {
  throw new AggregateError(errors, "Admission entry probe or cleanup failed");
}
fs.writeFileSync(
  reportPath,
  `${JSON.stringify(
    {
      entry: "dist/index.js",
      exit: result.status,
      pendingLifecycleMarkerPreserved: true,
      profileArtifactsPreserved: true,
      profileArtifactCount: before.length,
      verdict,
    },
    null,
    2,
  )}\n`,
);
console.log(
  "Actual package admission entry preserved pending lifecycle marker and all profile artifacts.",
);
