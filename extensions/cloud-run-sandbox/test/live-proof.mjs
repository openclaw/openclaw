// Opt-in Cloud Run proof. Runs the current plugin with the real launcher and
// SQLite store; the authority callback is controlled by this fault-injection fixture.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs, { watch } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-store-runtime";
import { createBackend, reserveRuntimeId } from "../src/backend.js";
import { GuestOwner } from "../src/guest.js";
import { buildNativeCommandSpec, invoke } from "../src/native.js";

const {
  argv: [LAUNCHER],
  env: LAUNCHER_ENV,
} = buildNativeCommandSpec([]);

const rootfs = process.argv[2];
const stateDir = process.argv[3];
const childMode = process.argv[4];
assert(rootfs && stateDir, "Usage: node live-proof.mjs <clean-rootfs> <fresh-local-state-dir>");
assert(path.isAbsolute(rootfs) && path.isAbsolute(stateDir), "Proof paths must be absolute");
assert([undefined, "orphan", "uncertain"].includes(childMode), "Unknown child mode");
assert(
  !fs.existsSync(stateDir) || fs.readdirSync(stateDir).length === 0,
  "Proof requires a fresh isolated state directory",
);
assert.equal(process.platform, "linux");
assert.equal(process.getuid(), 0);
assert(fs.existsSync(LAUNCHER), "Requires the Cloud Run sandbox launcher");
process.env.OPENCLAW_STATE_DIR = stateDir;
await fsp.mkdir(stateDir, { recursive: true, mode: 0o700 });
const config = { rootfs, allowEgress: false, guestLifetimeSeconds: 120 };
const cases = [];
const owners = [];
const storeFor = (namespace, directory = stateDir) =>
  createPluginStateKeyedStore("cloud-run-sandbox", {
    namespace,
    maxEntries: 10000,
    overflowPolicy: "reject-new",
    env: { ...process.env, OPENCLAW_STATE_DIR: directory },
  });

async function fixture(name, afterNative) {
  const work = path.join(stateDir, name, "workspace");
  const agent = path.join(stateDir, name, "agent");
  await fsp.mkdir(work, { recursive: true });
  await fsp.mkdir(agent, { recursive: true });
  const journal = storeFor(name);
  const trace = [];
  let current = true;
  const assertCurrent = () => {
    if (!current) {
      throw new Error("proof authority revoked");
    }
  };
  const owner = new GuestOwner(journal, async (args, options) => {
    const phase = args[0] === "exec" && options?.stdin !== undefined ? "stage" : args[0];
    const result = await invoke(args, options);
    trace.push({ phase, code: result.code });
    await afterNative?.({
      phase,
      result,
      revoke: () => {
        current = false;
      },
    });
    return result;
  });
  owners.push(owner);
  // Deliberately construct only the provider-consumed configuration. This is a
  // plugin/SDK boundary proof, not a model turn or core configuration-resolver test.
  const params = {
    runtimeId: reserveRuntimeId(),
    sessionKey: name,
    scopeKey: name,
    assertRuntimeCurrent: assertCurrent,
    workspaceDir: work,
    agentWorkspaceDir: agent,
    cfg: { backend: "cloud-run-sandbox", workspaceAccess: "none", docker: { env: {}, binds: [] } },
  };
  const backend = await createBackend(params, config, owner, stateDir);
  const bridge = backend.createFsBridge({
    sandbox: {
      workspaceDir: work,
      agentWorkspaceDir: agent,
      workspaceAccess: "none",
      containerName: params.runtimeId,
      containerWorkdir: "/workspace",
      docker: {},
      backend,
    },
  });
  return {
    backend,
    bridge,
    owner,
    journal,
    params,
    work,
    agent,
    trace,
    revoke: () => {
      current = false;
    },
  };
}

function hostCommand(argv, env = LAUNCHER_ENV) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 45000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(
        error instanceof Error ? error : new Error("Proof child process failed", { cause: error }),
      );
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
async function execute(backend, command, env = {}) {
  const cleanup = backend.prepareProcessCleanup(env);
  const spec = await backend.buildExecSpec({
    command,
    workdir: "/workspace",
    env: cleanup.env,
    usePty: false,
  });
  try {
    spec.assertCurrent();
    return await hostCommand(spec.argv, spec.env);
  } finally {
    await backend.finalizeExec({
      status: "completed",
      exitCode: null,
      timedOut: false,
      token: spec.finalizeToken,
    });
  }
}
function fileAppears(file) {
  return new Promise((resolve, reject) => {
    const watcher = watch(path.dirname(file), () => {
      if (fs.existsSync(file)) {
        clearTimeout(timer);
        watcher.close();
        resolve();
      }
    });
    const timer = setTimeout(() => {
      watcher.close();
      reject(new Error("guest never published started marker"));
    }, 10000);
  });
}
async function prove(name, fn) {
  try {
    const detail = await fn();
    cases.push({ name, pass: true, ...detail });
  } catch (error) {
    cases.push({ name, pass: false, error: String(error) });
  }
  console.log("CLOUD_RUN_PLUGIN_CASE " + JSON.stringify(cases.at(-1)));
}
async function noGuest(guestId) {
  const result = await invoke(["exec", guestId, "--", "/bin/true"]);
  assert.notEqual(result.code, 0, "guest still accepts execution");
  assert.match(result.stderr.toString(), /is not running/);
}

if (childMode) {
  const f = await fixture(childMode);
  if (childMode === "uncertain") {
    const realRegister = f.journal.register;
    f.journal.register = async (key, value, options) => {
      if (value.phase === "ready") {
        // Real process exit after native create, before its durable ready receipt.
        process.stdout.write(JSON.stringify({ guestId: key }) + "\n", () => process.exit(0));
        return await new Promise(() => {});
      }
      return await realRegister(key, value, options);
    };
  }
  await f.backend.buildExecSpec({ command: "exit 0", env: {}, usePty: false });
  const [row] = await f.journal.entries();
  process.stdout.write(JSON.stringify({ guestId: row.value.guestId }) + "\n", () =>
    process.exit(0),
  );
  await new Promise(() => {});
}

await prove("allowed-command-and-real-file-bridge", async () => {
  const f = await fixture("allowed");
  await f.bridge.writeFile({ filePath: "/workspace/file.txt", data: "REAL_PLUGIN_FILE" });
  assert.equal(
    (await f.bridge.readFile({ filePath: "/workspace/file.txt" })).toString(),
    "REAL_PLUGIN_FILE",
  );
  assert.equal(await fsp.readFile(path.join(f.work, "file.txt"), "utf8"), "REAL_PLUGIN_FILE");
  const result = await execute(f.backend, 'printf "%s" "$VALUE" > exec.txt', {
    VALUE: "EXPLICIT_ENV",
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await fsp.readFile(path.join(f.work, "exec.txt"), "utf8"), "EXPLICIT_ENV");
  assert.equal((await f.journal.entries()).length, 0);
  return { hostReadback: true, receiptsRemaining: 0, trace: f.trace };
});
await prove("parent-private-files-hidden", async () => {
  const f = await fixture("visibility");
  const canary = path.join(stateDir, "private-canary");
  await fsp.writeFile(canary, "SYNTHETIC_PRIVATE", { mode: 0o600 });
  const result = await f.backend.runShellCommand({ script: 'test ! -r "$1"', args: [canary] });
  assert.equal(result.code, 0);
  return { privateCanaryHidden: true };
});
for (const phase of ["run", "stage"]) {
  await prove("revocation-after-native-" + phase, async () => {
    const f = await fixture("revoke-" + phase, ({ phase: actual, result, revoke }) => {
      if (actual === phase && result.code === 0) {
        revoke();
      }
    });
    await assert.rejects(
      f.backend.buildExecSpec({ command: "touch /workspace/forbidden", env: {}, usePty: false }),
      /revoked/,
    );
    assert(!fs.existsSync(path.join(f.work, "forbidden")));
    assert.equal((await f.journal.entries()).length, 0);
    assert.deepEqual(
      f.trace.map((entry) => entry.phase),
      phase === "run" ? ["run", "delete"] : ["run", "stage", "delete"],
    );
    return { finalCommandAdmitted: false, receiptsRemaining: 0, trace: f.trace };
  });
}
await prove("revocation-before-final-spawn", async () => {
  const f = await fixture("revoke-spawn");
  const spec = await f.backend.buildExecSpec({
    command: "touch /workspace/forbidden",
    env: {},
    usePty: false,
  });
  f.revoke();
  assert.throws(() => spec.assertCurrent(), /revoked/);
  await f.backend.finalizeExec({
    status: "failed",
    exitCode: null,
    timedOut: false,
    token: spec.finalizeToken,
  });
  assert(!fs.existsSync(path.join(f.work, "forbidden")));
  assert.equal((await f.journal.entries()).length, 0);
  return { finalCommandAdmitted: false, receiptsRemaining: 0 };
});
await prove("revocation-before-file-mutation", async () => {
  const f = await fixture("revoke-file", ({ phase, result, revoke }) => {
    if (phase === "run" && result.code === 0) {
      revoke();
    }
  });
  await assert.rejects(
    f.bridge.writeFile({ filePath: "/workspace/forbidden", data: "MUST_NOT_WRITE" }),
    /revoked/,
  );
  assert(!fs.existsSync(path.join(f.work, "forbidden")));
  assert.equal((await f.journal.entries()).length, 0);
  return { fileMutationAdmitted: false, receiptsRemaining: 0, trace: f.trace };
});
await prove("active-cancel-and-independent-sibling", async () => {
  const f = await fixture("cancel");
  const started = fileAppears(path.join(f.work, "started"));
  const control = new AbortController();
  const command = f.backend
    .runShellCommand({
      script:
        "touch /workspace/started; while [ ! -f /workspace/release ]; do sleep 0.05; done; touch /workspace/after",
      signal: control.signal,
    })
    .catch((error) => error);
  await started;
  const sibling = await f.backend.buildExecSpec({
    command: "echo sibling",
    env: {},
    usePty: false,
  });
  control.abort();
  assert((await command) instanceof Error);
  await fsp.writeFile(path.join(f.work, "release"), "go");
  sibling.assertCurrent();
  const result = await hostCommand(sibling.argv, sibling.env);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /sibling/);
  await f.backend.finalizeExec({
    status: "completed",
    exitCode: 0,
    timedOut: false,
    token: sibling.finalizeToken,
  });
  assert(!fs.existsSync(path.join(f.work, "after")));
  assert.equal((await f.journal.entries()).length, 0);
  return { started: true, lateWrite: false, siblingCompleted: true, receiptsRemaining: 0 };
});
await prove("hostile-overlapping-source-refused", async () => {
  const f = await fixture("hostile");
  const alias = path.join(f.work, "root-alias");
  await fsp.symlink("/", alias);
  await assert.rejects(
    createBackend(
      { ...f.params, agentWorkspaceDir: alias, cfg: { ...f.params.cfg, workspaceAccess: "rw" } },
      config,
      f.owner,
      stateDir,
    ),
    /overlap/,
  );
  assert.equal(f.trace.length, 0);
  return { nativeCalls: 0 };
});
for (const mode of ["orphan", "uncertain"]) {
  await prove("persisted-" + mode + "-after-process-exit", async () => {
    const recoveryDir = path.join(stateDir, "recovery-" + mode);
    const child = await hostCommand(
      [process.execPath, fileURLToPath(import.meta.url), rootfs, recoveryDir, mode],
      { ...process.env, OPENCLAW_STATE_DIR: recoveryDir },
    );
    assert.equal(child.code, 0, child.stderr);
    const { guestId } = JSON.parse(child.stdout.trim().split("\n").at(-1));
    assert.equal(
      (await invoke(["exec", guestId, "--", "/bin/true"])).code,
      0,
      "seed guest did not survive child exit",
    );
    const journal = storeFor(mode, recoveryDir);
    const before = await journal.entries();
    assert.equal(before.length, 1);
    assert.equal(before[0].value.phase, mode === "orphan" ? "ready" : "creating");
    const owner = new GuestOwner(journal);
    owners.push(owner);
    if (mode === "orphan") {
      await owner.recover();
    } else {
      await assert.rejects(owner.recover(), /Unsettled/);
    }
    await noGuest(guestId);
    const remaining = (await journal.entries()).length;
    assert.equal(remaining, mode === "orphan" ? 0 : 1);
    return { separateProcess: true, guestDeleted: true, receiptsRemaining: remaining };
  });
}
const cleanup = await Promise.allSettled(owners.map((owner) => owner.stop()));
const cleanupFailures = cleanup.filter((result) => result.status === "rejected").length;
console.log(
  "CLOUD_RUN_PLUGIN_RESULT " +
    JSON.stringify({
      node: process.version,
      scope: "current plugin; real launcher and SQLite; controlled authority callback",
      cases,
      cleanupFailures,
      pass: cases.every((entry) => entry.pass) && cleanupFailures === 0,
    }),
);
process.exit(cases.every((entry) => entry.pass) && cleanupFailures === 0 ? 0 : 1);
