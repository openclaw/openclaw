import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  assertTaskflowGatewayReads,
  assertTaskflowIdentifiers,
  assertTaskflowSdkReads,
  assertTaskflowSnapshot,
  createTaskflowFixture,
  normalizeTaskflowSnapshot,
  TASKFLOW_METHOD,
  TASKFLOW_PLUGIN_MANIFEST,
  TASKFLOW_TASK_IDS,
} from "./taskflow-restoration-fixture.mjs";
import taskflowPlugin from "./taskflow-restoration-plugin.mjs";
import { resolveWorkerCellExport } from "./worker-cell-package.mjs";

const BASELINE_COMMIT = "3a9d69db306cd7f081e06254cb89c4bcc14a7107";
const pluginId = taskflowPlugin.id;
const BASELINE_MODULES = {
  "task-registry.store.sqlite-CI1kWe-v.mjs":
    "d4979372e7232d63ab7a92531b2ebab94631a74b88ac902ccbe0bcf58b5253b2",
  "task-flow-registry.store.sqlite-B6eAniay.mjs":
    "e04935c9d03883dc4da22af6443279754fda4d616bc85e38e59f7c2e6d1c5b66",
};
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    "package-root": { type: "string" },
    "expected-commit": { type: "string" },
    attempt: { type: "string", default: "first" },
    url: { type: "string" },
  },
});
const [mode] = positionals;
assert(
  positionals.length === 1 && ["seed", "assert-migrated", "assert-state", "probe"].includes(mode),
  "Expected seed, assert-migrated, assert-state, or probe",
);
assert(["first", "second"].includes(values.attempt), "Expected first or second attempt");
assert(values["package-root"], "--package-root is required");
const packageRoot = await fs.realpath(values["package-root"]);
const artifacts = process.env.OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT;
const runtimeRoot = process.env.OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT;
const stateDir = process.env.OPENCLAW_STATE_DIR;
const configPath = process.env.OPENCLAW_CONFIG_PATH;
assert(artifacts && runtimeRoot && stateDir && configPath, "Missing isolated survivor paths");
assert(path.isAbsolute(stateDir) && path.isAbsolute(configPath), "State paths must be absolute");
assert(
  path.resolve(stateDir).startsWith(`${path.resolve(runtimeRoot)}${path.sep}`),
  "Taskflow state must belong to its isolated runtime",
);
assert(
  path.resolve(configPath).startsWith(`${path.resolve(stateDir)}${path.sep}`),
  "Taskflow config must belong to its state root",
);
const expectedFile = path.join(artifacts, "taskflow-seed.json");
const moduleEvidence = [];

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function installedFile(relative) {
  const file = await fs.realpath(path.join(packageRoot, relative));
  assert(file.startsWith(`${packageRoot}${path.sep}`), "Installed module escaped package root");
  return file;
}

const manifest = await readJson(await installedFile("package.json"));
const build = await readJson(await installedFile("dist/build-info.json"));
assert.equal(manifest.name, "openclaw");
assert.equal(build.version, manifest.version);
const expectedCommit = mode === "seed" ? BASELINE_COMMIT : values["expected-commit"];
assert(/^[a-f0-9]{40}$/u.test(expectedCommit ?? ""), "Expected exact package commit");
assert.equal(build.commit, expectedCommit, "Installed package is not the selected source");
if (mode === "seed") {
  assert.equal(manifest.version, "2026.9.4");
}

async function loadOwner(prefix, names) {
  const files = (await fs.readdir(path.join(packageRoot, "dist"))).filter(
    (name) => name.startsWith(`${prefix}-`) && name.endsWith(".mjs"),
  );
  const matches = [];
  for (const name of files) {
    const file = await installedFile(`dist/${name}`);
    const source = await fs.readFile(file, "utf8");
    const exports = names.map((symbol) => resolveWorkerCellExport(source, symbol));
    if (exports.every(Boolean)) {
      matches.push({ file, name, exports, sha256: digest(source) });
    }
  }
  assert.equal(matches.length, 1, `Expected one installed ${prefix} owner`);
  const match = matches[0];
  if (mode === "seed") {
    assert.equal(match.sha256, BASELINE_MODULES[match.name], "Published owner bytes changed");
  }
  moduleEvidence.push({ file: match.file, sha256: match.sha256, names, exports: match.exports });
  const module = await import(pathToFileURL(match.file).href);
  return Object.fromEntries(
    names.map((name, index) => {
      const operation = module[match.exports[index]];
      assert.equal(typeof operation, "function", `Missing installed owner operation ${name}`);
      return [name, operation];
    }),
  );
}

async function withStores(operation) {
  const task = await loadOwner("task-registry.store.sqlite", [
    "upsertTaskWithDeliveryStateToSqlite",
    "loadTaskRegistryStateFromSqlite",
    "closeTaskRegistryDatabase",
  ]);
  const flow = await loadOwner("task-flow-registry.store.sqlite", [
    "upsertTaskFlowRegistryRecordToSqlite",
    "loadTaskFlowRegistryStateFromSqlite",
    "closeTaskFlowRegistryDatabase",
  ]);
  let failure;
  let result;
  try {
    result = operation(task, flow);
  } catch (error) {
    failure = error;
  }
  const errors = failure ? [failure] : [];
  for (const close of [flow.closeTaskFlowRegistryDatabase, task.closeTaskRegistryDatabase]) {
    try {
      close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) {
    throw new AggregateError(errors, "Task/flow owner operation or close failed");
  }
  return result;
}

function snapshot(task, flow) {
  return normalizeTaskflowSnapshot({
    ...task.loadTaskRegistryStateFromSqlite(),
    ...flow.loadTaskFlowRegistryStateFromSqlite(),
  });
}

async function databaseMetrics() {
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  const sizes = {};
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      sizes[suffix || "database"] = (await fs.stat(`${databasePath}${suffix}`)).size;
    } catch (error) {
      if (error.code !== "ENOENT" || suffix === "") {
        throw error;
      }
      sizes[suffix] = 0;
    }
  }
  // Both store owners are closed. This observer never repairs or writes schema.
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return {
      databasePath,
      sizes,
      schemaVersion: db.prepare("PRAGMA user_version").get().user_version,
    };
  } finally {
    db.close();
  }
}

async function readTaskIdentifiers() {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"), { readOnly: true });
  try {
    return db
      .prepare("SELECT task_id, run_id, child_session_key FROM task_runs ORDER BY task_id")
      .all()
      .map(({ task_id, run_id, child_session_key }) => ({ task_id, run_id, child_session_key }));
  } finally {
    db.close();
  }
}

async function seed() {
  const fixture = createTaskflowFixture(Date.now());
  const legacyFixture = {
    ...fixture,
    tasks: fixture.tasks.map((task, index) => ({
      ...task,
      runId: index === 0 ? ` ${task.runId} ` : index === 1 ? `\t${task.runId}\u00a0` : task.runId,
      childSessionKey: task.childSessionKey ? ` \t${task.childSessionKey}\n` : " \t\u00a0",
    })),
  };
  const restored = await withStores((task, flow) => {
    for (const record of fixture.flows) {
      flow.upsertTaskFlowRegistryRecordToSqlite(record);
    }
    for (const [index, record] of legacyFixture.tasks.entries()) {
      task.upsertTaskWithDeliveryStateToSqlite({
        task: record,
        deliveryState: fixture.deliveryStates[index],
      });
    }
    const actual = snapshot(task, flow);
    assertTaskflowSnapshot(actual, legacyFixture);
    return actual;
  });
  const identifiers = await readTaskIdentifiers();
  assertTaskflowIdentifiers(identifiers, legacyFixture);
  const pluginRoot = path.join(runtimeRoot, "taskflow-plugin");
  await fs.mkdir(pluginRoot, { recursive: true });
  for (const file of ["taskflow-restoration-plugin.mjs", "taskflow-restoration-fixture.mjs"]) {
    await fs.copyFile(new URL(file, import.meta.url), path.join(pluginRoot, file));
  }
  await writeJson(path.join(pluginRoot, "package.json"), {
    name: "@openclaw-test/taskflow-survivor",
    version: "1.0.0",
    type: "module",
    openclaw: { extensions: ["./taskflow-restoration-plugin.mjs"] },
  });
  await writeJson(path.join(pluginRoot, "openclaw.plugin.json"), TASKFLOW_PLUGIN_MANIFEST);
  const token = process.env.GATEWAY_AUTH_TOKEN_REF;
  assert(token, "Missing synthetic Gateway token");
  await writeJson(configPath, {
    gateway: {
      mode: "local",
      bind: "loopback",
      auth: { mode: "token", token },
      controlUi: { enabled: false },
    },
    agents: {
      defaults: { workspace: path.join(runtimeRoot, "workspace"), heartbeat: { every: "0m" } },
    },
    plugins: {
      allow: [pluginId],
      load: { paths: [pluginRoot] },
      entries: { [pluginId]: { enabled: true } },
    },
  });
  const expectedSnapshot = normalizeTaskflowSnapshot(fixture);
  await writeJson(expectedFile, {
    build,
    fixture,
    snapshot: expectedSnapshot,
    seedSnapshot: restored,
    seedSha256: digest(JSON.stringify(restored)),
    identifiers,
    modules: moduleEvidence,
    sha256: digest(JSON.stringify(expectedSnapshot)),
    database: await databaseMetrics(),
  });
}

async function assertMigrated() {
  const expected = await readJson(expectedFile);
  // Do not import candidate store owners: only the updater's Doctor may repair this specimen.
  const identifiers = await readTaskIdentifiers();
  await writeJson(path.join(artifacts, "taskflow-after-update.json"), { build, identifiers });
  assertTaskflowIdentifiers(identifiers, expected.fixture);
}

async function assertState() {
  const expected = await readJson(expectedFile);
  const actual = await withStores(snapshot);
  await writeJson(path.join(artifacts, `taskflow-after-${values.attempt}.json`), {
    build,
    snapshot: actual,
    modules: moduleEvidence,
    sha256: digest(JSON.stringify(actual)),
    database: await databaseMetrics(),
  });
  assertTaskflowSnapshot(actual, expected.snapshot);
}

async function probe() {
  assert(values.url, "--url is required");
  const url = new URL(values.url);
  assert(
    url.protocol === "ws:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname),
    "Expected isolated loopback Gateway",
  );
  const expected = await readJson(expectedFile);
  assert(process.env.GATEWAY_AUTH_TOKEN_REF, "Missing synthetic Gateway token");
  const require = createRequire(path.join(packageRoot, "package.json"));
  const sdkPath = await fs.realpath(require.resolve("openclaw/plugin-sdk/gateway-runtime"));
  assert(sdkPath.startsWith(`${packageRoot}${path.sep}`), "Gateway SDK escaped installed package");
  const { GatewayClient } = await import(pathToFileURL(sdkPath).href);
  let resolveHello;
  let rejectHello;
  const helloPromise = new Promise((resolve, reject) => {
    resolveHello = resolve;
    rejectHello = reject;
  });
  const client = new GatewayClient({
    url: values.url,
    token: process.env.GATEWAY_AUTH_TOKEN_REF,
    clientName: "cli",
    mode: "cli",
    role: "operator",
    scopes: ["operator.admin"],
    deviceIdentity: null,
    requestTimeoutMs: 60_000,
    onHelloOk: resolveHello,
    onConnectError: rejectHello,
  });
  const timer = setTimeout(
    () => rejectHello(new Error("Taskflow Gateway connection timed out")),
    60_000,
  );
  const started = performance.now();
  const evidence = { build, sdkPath, calls: [] };
  const output = path.join(artifacts, `taskflow-gateway-${values.attempt}.json`);
  const request = async (method, params) => {
    const start = performance.now();
    try {
      const payload = await client.request(method, params);
      evidence.calls.push({ method, params, payload, elapsedMs: performance.now() - start });
      return payload;
    } finally {
      await writeJson(output, evidence);
    }
  };
  try {
    client.start();
    const hello = await helloPromise;
    // hello.auth may contain a device token. The server object carries connId/bootId/buildId.
    evidence.hello = { type: hello.type, protocol: hello.protocol, server: hello.server };
    assert.equal(typeof hello.server.connId, "string");
    clearTimeout(timer);
    const query = { limit: 2, sortBy: "updatedAt" };
    const first = await request("tasks.list", query);
    assert.equal(typeof first.nextCursor, "string", "First page lacks continuation");
    const second = await request("tasks.list", { ...query, cursor: first.nextCursor });
    const details = [];
    for (const taskId of TASKFLOW_TASK_IDS) {
      details.push(await request("tasks.get", { taskId }));
    }
    const sdk = await request(TASKFLOW_METHOD, {});
    await writeJson(output, {
      ...evidence,
      elapsedMs: performance.now() - started,
      pages: [first, second],
      details,
      sdk,
    });
    assert.equal(sdk.stateDir, stateDir, "SDK reads used a different state root");
    assert.equal(sdk.runtimeVersion, manifest.version);
    assertTaskflowGatewayReads([first, second], details, expected.fixture);
    assertTaskflowSdkReads(sdk, expected.fixture);
  } finally {
    clearTimeout(timer);
    await client.stopAndWait();
  }
}

await (mode === "seed"
  ? seed()
  : mode === "assert-migrated"
    ? assertMigrated()
    : mode === "assert-state"
      ? assertState()
      : probe());
console.log(`taskflow-restoration:${mode} passed commit=${build.commit}`);
