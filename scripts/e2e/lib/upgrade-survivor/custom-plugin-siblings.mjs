import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { readJson, write } from "../fixtures/common.mjs";

const root = process.env.OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT;
const artifacts = process.env.OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT;
const stateDir = process.env.OPENCLAW_STATE_DIR;
const configPath = process.env.OPENCLAW_CONFIG_PATH;
assert(root && artifacts && stateDir && configPath, "Missing isolated survivor paths");
const pluginId = "survivor-sibling-memory";
const pluginRoot = path.join(root, "custom-plugins", "memory");
const sharedRoot = path.join(root, "custom-plugins", "shared");
const registrations = path.join(artifacts, "sibling-registrations.jsonl");
const evidencePath = path.join(artifacts, "sibling-source.json");
const marker = "OPENCLAW_SIBLING_SOURCE_OK";
const refusalArm = path.join(artifacts, "sibling-refusal.armed");
const refusalPreload = path.join(artifacts, "sibling-refusal-preload.mjs");
const refusalWorker = path.join(artifacts, "sibling-refusal-worker.json");
const refusalChild = path.join(artifacts, "sibling-refusal-child.json");
const refusalBaseline = path.join(artifacts, "sibling-refusal-baseline.json");
const activationSeed = path.join(artifacts, "sibling-activation-seed.json");

function seedActivationHealth(databasePath, engineId) {
  const database = new DatabaseSync(databasePath, { timeout: 5000 });
  const entries = [
    [engineId, process.pid],
    [`${engineId}-unselected`, process.pid],
    [engineId, process.ppid],
  ].map(([selectedId, processId]) => ({
    key: JSON.stringify([selectedId, processId]),
    value: JSON.stringify({
      engineId: selectedId,
      processId,
      processToken: "survivor-activation-fixture",
      processStartTime: null,
      failedAtMs: Date.now(),
      operation: "resolve",
      reason: "persisted activation fixture",
    }),
  }));
  try {
    const insert = database.prepare(
      "INSERT INTO plugin_state_entries (plugin_id, namespace, entry_key, value_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, NULL)",
    );
    for (const entry of entries) {
      insert.run(
        "core:context-engine-quarantine-health",
        "runtime-quarantines",
        entry.key,
        entry.value,
        Date.now(),
      );
    }
  } finally {
    database.close();
  }
  return { databasePath, processId: process.pid, entries };
}

function processIdentity(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return {
      pid,
      ppid: Number(fields[1]),
      command: stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")")),
      group: Number(fields[2]),
      start: fields[19],
      state: fields[0],
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function survivingRefusalProcesses() {
  const record = readJson(refusalChild);
  assert.equal(record.child.group, record.worker.pid, "Output child escaped its worker group");
  assert.equal(record.worker.group, record.worker.pid, "Worker is not its group leader");
  return [record.worker, record.child].flatMap((expected) => {
    const current = processIdentity(expected.pid);
    return current?.start === expected.start ? [{ ...current, expectedGroup: expected.group }] : [];
  });
}

function installationDigest(packageRoot) {
  const hash = createHash("sha256");
  function visit(relative) {
    const file = path.join(packageRoot, relative);
    const stat = fs.lstatSync(file);
    hash.update(JSON.stringify([relative, stat.mode]));
    if (stat.isSymbolicLink()) {
      hash.update(fs.readlinkSync(file));
    } else if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).toSorted()) {
        visit(path.join(relative, name));
      }
    } else {
      assert(stat.isFile(), `Unexpected installed file type: ${relative}`);
      hash.update(fs.readFileSync(file));
    }
  }
  visit("");
  return hash.digest("hex");
}

function armRefusal(packageRoot) {
  assert.equal(process.platform, "linux", "Refusal process identity proof requires Linux");
  const installed = readJson(path.join(packageRoot, "package.json"));
  assert.equal(installed.version, "2026.9.6", "Refusal proof requires the published 9.6 updater");
  const operatorFile = path.join(root, "workspace", "MEMORY.md");
  write(operatorFile, "# Existing operator memory\nPreserve this through the refused update.\n");
  write(
    refusalBaseline,
    JSON.stringify({
      packageRoot: fs.realpathSync(packageRoot),
      installation: installationDigest(packageRoot),
      config: digest(configPath),
      operatorFile,
      operator: digest(operatorFile),
    }),
  );
  write(refusalArm, "armed\n");
}

function assertRefusal(packageRoot, exitCode) {
  assert.equal(Number(exitCode), 1, "Published updater did not report a failed update");
  const result = readJson(path.join(artifacts, "sibling-refusal-update.json"));
  assert.equal(result.status, "error");
  assert.equal(result.before?.version, "2026.9.6");
  const failed = result.steps.find((step) => step.name === "candidate-doctor-lint");
  assert(failed, "Candidate Doctor lint was not reached");
  assert.equal(failed.exitCode, 2, "Supervisor did not refuse after its readiness report");
  assert.equal(failed.termination, "exit");
  assert.equal(
    failed.outputLimitExceeded,
    false,
    "The outer canary, not the worker, hit its limit",
  );
  assert.equal(failed.advisory, undefined, "Supervisor refusal became an advisory");
  const fact = failed.failureFacts?.find((entry) => entry.code === "doctor-failed");
  assert.match(fact?.message ?? "", /Doctor lint settlement refused: output-limit;/u);
  assert.match(fact.message, /kill-issued-by-abort/u);
  assert.doesNotMatch(fact.message, /cleanup-uncertain/u);
  assert.equal(fact.message.length <= 200, true, "Refusal exceeded the persisted fact budget");
  const status = spawnSync("openclaw", ["update", "status", "--json"], {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  write(path.join(artifacts, "sibling-refusal-status.json"), status.stdout ?? "");
  write(path.join(artifacts, "sibling-refusal-status.err"), status.stderr ?? "");
  assert.equal(status.status, 0, `Cannot read saved update result: ${status.stderr}`);
  const saved = JSON.parse(status.stdout);
  assert.equal(saved.runStatusError, undefined);
  assert.equal(saved.activeRun, undefined, "Refused update retained a live run");
  assert(result.runId, "Failed update omitted its run ID");
  assert.equal(saved.lastRun?.runId, result.runId, "Status returned another update's result");
  assert.equal(saved.lastRun.status, "failed");
  assert(
    saved.lastRun.steps.some(
      (step) =>
        step.status === "failed" &&
        step.failureFacts?.some(
          (entry) => entry.code === fact.code && entry.message === fact.message,
        ),
    ),
    "Saved failed run lost the authentic supervisor refusal",
  );
  const before = readJson(refusalBaseline);
  assert.equal(fs.realpathSync(packageRoot), before.packageRoot);
  assert.equal(
    installationDigest(packageRoot),
    before.installation,
    "Refusal changed the installation",
  );
  assert.equal(digest(configPath), before.config, "Refusal changed operator config");
  assert.equal(digest(before.operatorFile), before.operator, "Refusal changed operator memory");
  for (const [file, expected] of Object.entries(readJson(evidencePath))) {
    assert.equal(digest(file), expected, `Refusal changed original plugin source: ${file}`);
  }
  assert.deepEqual(
    survivingRefusalProcesses(),
    [],
    "Supervisor left an owned fixture process alive",
  );
  fs.unlinkSync(refusalArm);
  // Keep refusal evidence separate; the existing assertion must prove the healthy retry itself.
  fs.renameSync(registrations, path.join(artifacts, "sibling-refusal-registrations.jsonl"));
  write(registrations, "");
  console.log(
    "Published 9.6 updater retained the supervisor refusal, prior installation, and operator data; worker group stopped",
  );
}

function cleanupRefusal() {
  fs.rmSync(refusalArm, { force: true });
  if (!fs.existsSync(refusalChild)) {
    return;
  }
  const survivors = survivingRefusalProcesses();
  write(
    path.join(artifacts, "sibling-refusal-cleanup.json"),
    JSON.stringify({ survivors, namespaceInit: processIdentity(1) }),
  );
  // These are not this process's children. Preserve identities for the container
  // owner instead of signalling a stale group or claiming that a signal joined it.
  assert.deepEqual(survivors, [], "Refusal cleanup incomplete; recorded processes remain");
}

function digest(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function seed() {
  write(registrations, "");
  const observe = (surface) => `fs.appendFileSync(${JSON.stringify(registrations)}, JSON.stringify({
      value,
      surface: ${JSON.stringify(surface)},
      stateDir: process.env.OPENCLAW_STATE_DIR,
      source: import.meta.url,
      sharedSource,
      sourceSha256: createHash("sha256").update(fs.readFileSync(new URL(import.meta.url))).digest("hex"),
      sharedSourceSha256: createHash("sha256").update(fs.readFileSync(new URL(sharedSource))).digest("hex"),
      argv: process.argv.slice(2),
    }) + "\\n");`;
  const files = {
    [path.join(pluginRoot, "package.json")]: JSON.stringify({
      name: "@openclaw-test/survivor-sibling-memory",
      version: "1.0.0",
      type: "module",
      openclaw: { extensions: ["./index.mjs"] },
    }),
    [path.join(pluginRoot, "openclaw.plugin.json")]: JSON.stringify({
      id: pluginId,
      kind: ["memory", "context-engine"],
      doctorContract: { configRepair: true },
      configSchema: { type: "object", properties: {}, additionalProperties: false },
    }),
    [path.join(sharedRoot, "value.mjs")]:
      `export default ${JSON.stringify(marker)};\nexport const sharedSource = import.meta.url;\n`,
    [path.join(pluginRoot, "index.mjs")]: `import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import value, { sharedSource } from "../shared/value.mjs";
${seedActivationHealth.toString()}
export default {
  id: ${JSON.stringify(pluginId)},
  kind: ["memory", "context-engine"],
  register(api) {
    api.registerContextEngine(${JSON.stringify(pluginId)}, () => ({
      info: { id: ${JSON.stringify(pluginId)}, name: "Survivor context", version: "1.0.0" },
      async ingest() { return { ingested: false }; },
      async assemble({ messages }) { return { messages, estimatedTokens: 0 }; },
      async compact() { return { ok: true, compacted: false, reason: "fixture" }; },
    }));
    // Author fixture rows before the real activation owner runs. Canary and
    // inspection processes keep their existing read-only/state-copy contracts.
    if (process.env.OPENCLAW_UPGRADE_SURVIVOR_CONTEXT_ACTIVATION === "1" &&
        api.registrationMode === "full" && process.argv.includes("gateway") &&
        process.env.OPENCLAW_STATE_DIR === ${JSON.stringify(stateDir)} &&
        !process.argv.includes("--update-canary")) {
      if (api.config.plugins.slots.contextEngine !== ${JSON.stringify(pluginId)}) {
        throw new Error("Survivor context engine is not selected");
      }
      const seeded = seedActivationHealth(
        path.join(process.env.OPENCLAW_STATE_DIR, "state", "openclaw.sqlite"),
        ${JSON.stringify(pluginId)},
      );
      fs.writeFileSync(${JSON.stringify(activationSeed)}, JSON.stringify(seeded), { flag: "wx" });
    }
    ${observe("runtime")}
  },
};
`,
    [path.join(pluginRoot, "doctor-contract-api.mjs")]: `import fs from "node:fs";
import { createHash } from "node:crypto";
import value, { sharedSource } from "../shared/value.mjs";
${observe("doctor-module")}
export function normalizeCompatibilityConfig({ cfg }) {
  ${observe("doctor-contract")}
  return { config: cfg, changes: [] };
}
`,
    [refusalPreload]: `import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { isMainThread } from "node:worker_threads";
${processIdentity.toString()}
const privateRoot = process.env.OPENCLAW_STATE_DIR;
if (isMainThread &&
    fs.existsSync(${JSON.stringify(refusalArm)}) &&
    path.isAbsolute(privateRoot ?? "") &&
    privateRoot !== ${JSON.stringify(stateDir)} &&
    path.basename(privateRoot ?? "").startsWith("openclaw-update-canary-") &&
    process.env.OPENCLAW_CONFIG_PATH === path.join(privateRoot, "openclaw.json") &&
    process.env.OPENCLAW_UPDATE_IN_PROGRESS === "0" &&
    process.argv[1]?.endsWith("/dist/commands/doctor-lint.worker.js")) {
  fs.writeFileSync(${JSON.stringify(refusalWorker)}, JSON.stringify({
    worker: processIdentity(process.pid),
    namespaceInit: processIdentity(1),
    entry: process.argv[1],
    stateDir: privateRoot,
    configPath: process.env.OPENCLAW_CONFIG_PATH,
    operatorStateDir: ${JSON.stringify(stateDir)},
    operatorConfigPath: ${JSON.stringify(configPath)},
  }), { flag: "wx" });
  process.once("exit", (code) => {
    if (code !== 0) return;
    // The real worker validates its rehearsal and emits readiness before exit.
    // Join the child so root-exit cleanup cannot race ahead of its bounded output.
    spawnSync(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(`
import fs from "node:fs";
import { once } from "node:events";
${processIdentity.toString()}
const worker = processIdentity(process.ppid);
const child = processIdentity(process.pid);
fs.writeFileSync(${JSON.stringify(refusalChild)}, JSON.stringify({ worker, child, namespaceInit: processIdentity(1) }), { flag: "wx" });
const bytes = Buffer.alloc(2 * 1024 * 1024, " ");
for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
  if (!process.stdout.write(bytes.subarray(offset, offset + 64 * 1024))) {
    await once(process.stdout, "drain");
  }
}
`)}], { stdio: ["ignore", "inherit", "inherit"] });
  });
}
`,
  };
  for (const [file, contents] of Object.entries(files)) {
    write(file, contents);
  }
  write(
    evidencePath,
    JSON.stringify(Object.fromEntries(Object.keys(files).map((file) => [file, digest(file)]))),
  );
  write(
    configPath,
    JSON.stringify({
      gateway: {
        mode: "local",
        bind: "loopback",
        auth: { mode: "token", token: "survivor-sibling-token" },
        controlUi: { enabled: false },
      },
      agents: { defaults: { workspace: path.join(root, "workspace"), heartbeat: { every: "0m" } } },
      plugins: {
        allow: [pluginId],
        load: { paths: [pluginRoot] },
        entries: { [pluginId]: { enabled: true } },
        slots: { memory: pluginId, contextEngine: pluginId },
      },
    }),
  );
}

function inspect(stage) {
  const result = spawnSync("openclaw", ["plugins", "inspect", pluginId, "--runtime", "--json"], {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  write(path.join(artifacts, `sibling-${stage}.json`), result.stdout ?? "");
  write(path.join(artifacts, `sibling-${stage}.err`), result.stderr ?? "");
  assert.equal(result.status, 0, `Plugin runtime inspection failed: ${result.stderr}`);
  const output = JSON.parse(result.stdout);
  assert.equal(output.plugin?.status, "loaded", `Custom plugin did not load: ${result.stdout}`);
  console.log(`${stage}: enabled sibling-import plugin loaded`);
}

function assertCanary() {
  const events = fs
    .readFileSync(registrations, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const canary = events.filter(
    (event) => event.stateDir !== stateDir && event.stateDir?.includes("openclaw-update-canary-"),
  );
  assert(
    canary.some((event) => event.surface === "doctor-contract"),
    "No custom plugin Doctor contract execution from the private update canary; healthy readiness alone does not prove sibling imports",
  );
  assert(
    canary.some((event) => event.surface === "runtime" && event.argv.includes("--update-canary")),
    "The private Gateway canary did not register the enabled custom plugin",
  );
  for (const event of canary) {
    assert.equal(event.value, marker, "Canary loaded the wrong sibling source");
    for (const field of ["source", "sharedSource"]) {
      const url = new URL(event[field]);
      assert.equal(url.protocol, "file:", `Canary ${field} is not a file URL`);
      const relative = path.relative(event.stateDir, fileURLToPath(url));
      assert(
        relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
        `Canary ${field} resolved outside its private state: ${event[field]}`,
      );
    }
  }
  const config = readJson(configPath);
  assert.equal(
    config.plugins.entries[pluginId].enabled,
    true,
    "Updater disabled the custom plugin",
  );
  assert.equal(config.plugins.slots.memory, pluginId, "Updater replaced the memory plugin");
  assert.equal(config.plugins.slots.contextEngine, pluginId, "Updater replaced the context engine");
  for (const [file, expected] of Object.entries(readJson(evidencePath))) {
    assert.equal(digest(file), expected, `Updater changed original plugin source: ${file}`);
  }
  write(
    path.join(artifacts, "sibling-canary.json"),
    JSON.stringify({ marker, registrations: canary }, null, 2),
  );
  console.log(
    `canary: ${canary.length} actual plugin executions resolved sibling source; original files preserved`,
  );
}

function assertActivation() {
  const activation = readJson(activationSeed);
  assert.equal(activation.databasePath, path.join(stateDir, "state", "openclaw.sqlite"));
  assert.equal(activation.entries.length, 3, "Activation did not author all fixture records");
  process.kill(activation.processId, 0);
  const config = readJson(configPath);
  assert.equal(config.plugins.slots.contextEngine, pluginId);
  const database = new DatabaseSync(activation.databasePath, { readOnly: true });
  try {
    const read = database.prepare(
      "SELECT value_json FROM plugin_state_entries WHERE plugin_id = ? AND namespace = ? AND entry_key = ?",
    );
    const rows = activation.entries.map(({ key }) =>
      read.get("core:context-engine-quarantine-health", "runtime-quarantines", key),
    );
    assert.equal(rows[0], undefined, "Ready Gateway retained its selected activation quarantine");
    assert.equal(
      rows[1]?.value_json,
      activation.entries[1].value,
      "Activation changed another engine",
    );
    assert.equal(
      rows[2]?.value_json,
      activation.entries[2].value,
      "Activation changed another process",
    );
  } finally {
    database.close();
  }
  const receipt = {
    processId: activation.processId,
    selectedEngine: pluginId,
    selectedQuarantineCleared: true,
    otherEnginePreserved: true,
    otherProcessPreserved: true,
  };
  write(path.join(artifacts, "sibling-activation.json"), JSON.stringify(receipt));
  console.log("Ready candidate context-engine activation:", JSON.stringify(receipt));
}

const [mode, packageRoot, exitCode] = process.argv.slice(2);
if (mode === "seed") {
  seed();
} else if (mode === "baseline" || mode === "candidate") {
  inspect(mode);
} else if (mode === "arm-refusal") {
  armRefusal(packageRoot);
} else if (mode === "assert-refusal") {
  assertRefusal(packageRoot, exitCode);
} else if (mode === "cleanup-refusal") {
  cleanupRefusal();
} else if (mode === "assert-canary") {
  assertCanary();
} else if (mode === "assert-activation") {
  assertActivation();
} else {
  throw new Error(`Unknown sibling fixture mode: ${mode}`);
}
