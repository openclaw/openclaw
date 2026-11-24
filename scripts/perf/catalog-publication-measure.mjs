// Synthetic owner benchmark, not a whole-Gateway or kernel/btrfs benchmark.
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/catalog-publication-measure.mjs \
//   --state-dir /absolute/new-fixture --create --sessions 5000 --database-gib 35 \
//   --workspace-files 62000 --workspace-file-bytes 17742 --samples 5 --delay-ms 2000
// Run the same fixture and script against pinned base/candidate, alternating processes.
// Repeat base/base with --label A1/A2 for A/A controls. Preserve cold/warm labels.
// Acceptance: candidate makes zero lock creates and zero main-thread Sync calls;
// with a 2s create delay armed, its max loop gap stays below 100ms. Base must
// hit that native create once. Compare undelayed medians/p95, CPU and allocation
// separately (five samples/arm); investigate any >20% regression against A/A spread.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    create: { type: "boolean", default: false },
    sessions: { type: "string", default: "5000" },
    "database-gib": { type: "string", default: "0" },
    "workspace-files": { type: "string", default: "0" },
    "workspace-file-bytes": { type: "string", default: "17742" },
    samples: { type: "string", default: "5" },
    "delay-ms": { type: "string", default: "0" },
    label: { type: "string", default: "candidate" },
  },
});
const integer = (name, minimum, maximum) => {
  const value = Number(values[name]);
  assert(Number.isSafeInteger(value) && value >= minimum && value <= maximum, `Invalid --${name}`);
  return value;
};
assert(values["state-dir"] && path.isAbsolute(values["state-dir"]), "--state-dir must be absolute");
assert(global.gc, "Run with --expose-gc");
assert(Number.isFinite(getHeapStatistics().total_allocated_bytes), "Node 26.12+ required");
const root = values["state-dir"];
const samples = integer("samples", 1, 100);
const delayMs = integer("delay-ms", 0, 13_000);
const databaseGiB = integer("database-gib", 0, 40);
const sessionCount = integer("sessions", 1, 20_000);
const workspaceFiles = integer("workspace-files", 0, 100_000);
const workspaceFileBytes = integer("workspace-file-bytes", 0, 32_768);
const sleeper = new Int32Array(new SharedArrayBuffer(4));
let active;
const originals = Object.getOwnPropertyDescriptors(fs);
for (const [name, original] of Object.entries(fs)) {
  if (name.endsWith("Sync") && typeof original === "function") {
    const measured = new Proxy(original, {
      apply(target, receiver, args) {
        if (active) {
          active.syncCalls[name] = (active.syncCalls[name] ?? 0) + 1;
        }
        return Reflect.apply(target, receiver, args);
      },
    });
    Object.defineProperty(fs, name, { ...originals[name], value: measured });
  }
}
const originalRealpathNative = fs.realpathSync.native;
fs.realpathSync.native = (...args) => {
  if (active) {
    active.syncCalls["realpathSync.native"] = (active.syncCalls["realpathSync.native"] ?? 0) + 1;
  }
  return originalRealpathNative(...args);
};
syncBuiltinESMExports();

const { createGatewayBenchEnv } = await import("../lib/gateway-bench-runtime.ts");
const configPath = path.join(root, "openclaw.json");
process.env = {
  ...createGatewayBenchEnv(path.join(root, "home"), configPath, { startupTrace: false }),
  OPENCLAW_STATE_DIR: root,
  TMPDIR: path.join(root, "tmp"),
  OPENCLAW_FS_SAFE_NATIVE_MODE: "required",
};
const { getFsSafeNativeStatus } = await import("@openclaw/fs-safe/config");
const nativeStatus = await getFsSafeNativeStatus({ probe: true });
assert.equal(nativeStatus.loaded, true);
assert.equal(typeof nativeStatus.packageName, "string");
// Use the owner's selected addon, sharing its existing require-cache identity.
const requireNative = createRequire(import.meta.resolve("@openclaw/fs-safe/config"));
const nativeAddon = requireNative(nativeStatus.packageName);
const open = nativeAddon.openBeneath;
assert.equal(typeof open, "function");
nativeAddon.openBeneath = function (...input) {
  const sample = active;
  if (
    sample &&
    typeof input[1] === "string" &&
    input[1].endsWith(".plugin-model-catalog.lock") &&
    input[2] & fs.constants.O_CREAT
  ) {
    sample.lockCreates++;
    if (delayMs && !sample.injected) {
      sample.injected = true;
      const blockedAt = performance.now();
      setTimeout(() => {
        sample.injectedTimerDelayMs = performance.now() - blockedAt;
      }, 0);
      Atomics.wait(sleeper, 0, 0, delayMs);
    }
  }
  return Reflect.apply(open, this, input);
};
if (values.create) {
  const { generateTeamShapeFixture, parseTeamShapeOptions } =
    await import("./team-shape-fixture.ts");
  await generateTeamShapeFixture(
    parseTeamShapeOptions([
      "--state-dir",
      root,
      "--sessions",
      String(sessionCount),
      "--runs",
      "0",
      "--approvals",
      "0",
      "--cron",
      "0",
      "--projects",
      workspaceFiles ? "1" : "0",
      "--transcript-mib",
      "1",
      "--worktree-files",
      String(workspaceFiles),
      "--worktree-file-bytes",
      String(workspaceFileBytes),
    ]),
  );
}
const fixture = JSON.parse(fs.readFileSync(path.join(root, "team-shape-summary.json"), "utf8"));
assert.equal(
  fixture.format,
  "openclaw-team-shape-v1",
  "Only a generated synthetic fixture is accepted",
);
const agentDir = path.join(root, "agents", "main", "agent");
const databasePath = path.join(agentDir, "openclaw-agent.sqlite");
const agentDb = await import("../../src/state/openclaw-agent-db.js");
const stateDb = await import("../../src/state/openclaw-state-db.js");
if (values.create && databaseGiB) {
  const database = agentDb.openOpenClawAgentDatabase({ agentId: "main" });
  await database.walMaintenance.stop();
  const targetPages = Math.ceil(
    (databaseGiB * 1024 ** 3) / database.db.prepare("PRAGMA page_size").get().page_size,
  );
  const payload = JSON.stringify("synthetic-padding-".repeat(65_536));
  let row = 0;
  while (database.db.prepare("PRAGMA page_count").get().page_count < targetPages) {
    agentDb.runOpenClawAgentWriteTransaction(
      ({ db }) => {
        const insert = db.prepare(
          "INSERT INTO cache_entries (scope, key, value_json, updated_at) VALUES (?, ?, ?, 1)",
        );
        for (let index = 0; index < 64; index++) {
          insert.run("synthetic-catalog-pressure", String(row++), payload);
        }
      },
      { agentId: "main" },
    );
    database.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    await delay(0);
  }
  await agentDb.closeOpenClawAgentDatabasesAsync();
  await stateDb.closeOpenClawStateDatabaseAsync();
}
const { acquireGatewayStateOwner } = await import("../../src/infra/gateway-state-owner.js");
const { readGatewayLockProcessNamespace } = await import("../../src/infra/gateway-lock-payload.js");
const { resolveOpenClawStateSqlitePath } =
  await import("../../src/state/openclaw-state-db.paths.js");
const { registerResolvedAgentDir } = await import("../../src/agents/agent-dir-registry.js");
const { drainGlobalSingletonLifecycleState } = await import("../../src/shared/global-singleton.js");
const catalogs = await import("../../src/agents/plugin-model-catalog.js");
registerResolvedAgentDir({ agentId: "main", agentDir, env: process.env });
const owner = acquireGatewayStateOwner({
  databasePath: resolveOpenClawStateSqlitePath(process.env),
  payload: {
    pid: process.pid,
    createdAt: new Date().toISOString(),
    configPath,
    role: "gateway",
    processNamespace: readGatewayLockProcessNamespace(),
  },
});
let revision = 0;
const publish = () =>
  catalogs.replacePersistedPluginModelCatalogs({
    agentDir,
    pluginCatalogWrites: Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [
        catalogs.encodePluginModelCatalogRelativePath(`fixture-${index}`),
        JSON.stringify({
          generatedBy: catalogs.PLUGIN_MODEL_CATALOG_GENERATED_BY,
          providers: {
            fixture: {
              api: "openai-completions",
              models: Array.from({ length: 20 }, (_entry, model) => ({
                id: `model-${model}`,
                name: `Synthetic ${revision} ${model}`,
              })),
            },
          },
        }),
      ]),
    ),
  });
try {
  console.log(
    JSON.stringify({
      type: "fixture",
      label: values.label,
      node: process.version,
      platform: process.platform,
      ownerSha256: createHash("sha256")
        .update(
          fs.readFileSync(new URL("../../src/agents/plugin-model-catalog.ts", import.meta.url)),
        )
        .update(
          fs.readFileSync(
            new URL("../../src/agents/plugin-model-catalog-execution.ts", import.meta.url),
          ),
        )
        .update(
          fs.readFileSync(
            new URL("../../src/agents/plugin-model-catalog-credentials.ts", import.meta.url),
          ),
        )
        .digest("hex"),
      filesystemType: fs.statfsSync(root).type,
      agentDatabaseBytes: fs.statSync(databasePath).size,
      sessionCount: fixture.sessionCount,
      workspaceFiles: fixture.worktreeFiles,
      workspaceFileBytes: fixture.worktreeFileBytes,
      scope:
        "catalog publication owner under Gateway custody; unrelated rows/files create scale only",
    }),
  );
  await publish();
  for (let index = 0; index < samples; index++) {
    revision++;
    global.gc();
    const heartbeatGaps = [];
    let previousTick = performance.now();
    const heartbeat = setInterval(() => {
      const now = performance.now();
      heartbeatGaps.push(now - previousTick);
      previousTick = now;
    }, 1).unref();
    await delay(10);
    heartbeatGaps.length = 0;
    previousTick = performance.now();
    const metrics = { syncCalls: {}, lockCreates: 0, injected: false };
    const heap = getHeapStatistics().total_allocated_bytes;
    const cpu = process.cpuUsage();
    const threadCpu = process.threadCpuUsage();
    const started = performance.now();
    active = metrics;
    const result = await publish();
    active = undefined;
    const elapsedMs = performance.now() - started;
    const mainCpu = process.threadCpuUsage(threadCpu);
    const totalCpu = process.cpuUsage(cpu);
    const allocatedBytes = getHeapStatistics().total_allocated_bytes - heap;
    assert.equal(result.changed, true, "Each measured publication must change stored catalogs");
    assert.equal(result.catalogs.length, 40);
    await delay(5);
    clearInterval(heartbeat);
    heartbeatGaps.sort((left, right) => left - right);
    console.log(
      JSON.stringify({
        type: "sample",
        label: values.label,
        index,
        phase: "warm",
        delayMs,
        ...metrics,
        elapsedMs,
        mainCpuUs: mainCpu.user + mainCpu.system,
        totalCpuUs: totalCpu.user + totalCpu.system,
        allocatedBytes,
        loopMaxMs: heartbeatGaps.at(-1),
        loopP99Ms:
          heartbeatGaps[
            Math.min(heartbeatGaps.length - 1, Math.floor(heartbeatGaps.length * 0.99))
          ],
        hostLoad: loadavg(),
      }),
    );
  }
  const { loadPersistedPluginModelCatalogs } =
    await import("../../src/agents/plugin-model-catalog-execution.js");
  const stored = await loadPersistedPluginModelCatalogs(agentDir, ["fixture-0"]);
  assert.equal(
    JSON.parse(stored[0].contents).providers.fixture.models[0].name,
    `Synthetic ${revision} 0`,
    "A fresh catalog reader must observe the final committed publication",
  );
} finally {
  active = undefined;
  await agentDb.closeOpenClawAgentDatabasesAsync();
  await stateDb.closeOpenClawStateDatabaseAsync();
  owner.release();
  await drainGlobalSingletonLifecycleState();
  Object.defineProperties(fs, originals);
  fs.realpathSync.native = originalRealpathNative;
  syncBuiltinESMExports();
  nativeAddon.openBeneath = open;
}
