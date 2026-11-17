// Owner-level shutdown proof with real SQLite workers and a retained state lease.
// Prepare once with shutdown-loaded-fixture.mjs; run each source checkout serially:
// node --import ./scripts/tsx.mjs scripts/perf/sqlite-singleton-shutdown-measure.mjs \
//   --checkout <source> --fixture <synthetic-shape> --output <new-result.json>
// Measures agent close + final singleton drain, not channel drain or systemd.
// CPU covers this process; sampled allocation covers only the main isolate.
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    checkout: { type: "string", default: process.cwd() },
    fixture: { type: "string" },
    output: { type: "string" },
  },
});
assert(values.fixture && values.output);
const root = path.resolve(values.fixture);
const source = path.resolve(values.checkout);
const load = (file) => import(pathToFileURL(path.join(source, file)).href);
const { createGatewayBenchEnv } = await load("scripts/lib/gateway-bench-runtime.ts");
process.env = {
  ...createGatewayBenchEnv(path.join(root, "home"), path.join(root, "openclaw.json"), {
    startupTrace: false,
  }),
  OPENCLAW_STATE_DIR: root,
  TMPDIR: path.join(root, "tmp"),
};
const shape = JSON.parse(await readFile(path.join(root, "shape.json"), "utf8"));
assert(shape.sessions >= 5000 && shape.dbBytes >= 35 * 1024 ** 3);
assert(shape.workspaceFiles === 62000 && shape.workspaceBytes >= 1.1e9);
const agent = await load("src/state/openclaw-agent-db.ts");
const state = await load("src/state/openclaw-state-db.ts");
const { withOpenClawStateLeaseAsync } = await load("src/state/openclaw-state-lease.ts");
const { captureOpenClawStateWorkerContext } = await load(
  "src/state/openclaw-state-worker-context.ts",
);
const { drainGlobalSingletonLifecycleState } = await load("src/shared/global-singleton.ts");
const { createGatewayRunCleanup } = await load("src/cli/gateway-cli/run-loop-cleanup.ts");
const { closeDefaultRetainedNativeWorkerSource } = await load(
  "src/infra/worker-native-lifecycle.ts",
);
const { createDeferredCore } = await load("src/shared/deferred.ts");
const errors = [];
const cleanup = createGatewayRunCleanup(
  false,
  {},
  {
    warn: (message) => errors.push(message),
    error: (message) => errors.push(message),
  },
  () => false,
  () => {},
  () => {},
);
agent.openOpenClawAgentDatabase({ agentId: "main", env: process.env });
const entered = createDeferredCore();
const work = withOpenClawStateLeaseAsync(
  { scope: "core:shutdown-measure", key: "retained", waitMs: 0, leaseMs: 30_000 },
  captureOpenClawStateWorkerContext({ env: process.env }),
  async (lease) => {
    entered.resolve();
    if (!lease.signal.aborted) await once(lease.signal, "abort");
  },
);
const workOutcome = work.then(
  () => null,
  (error) => String(error),
);
await Promise.race([
  entered.promise,
  work.then(() => {
    throw new Error("Lease never entered");
  }),
]);
const inspector = new Session();
inspector.connect();
await inspector.post("HeapProfiler.startSampling", {
  samplingInterval: 32768,
  includeObjectsCollectedByMajorGC: true,
  includeObjectsCollectedByMinorGC: true,
});
const cpu = process.cpuUsage();
const start = performance.now();
let closeError;
try {
  await agent.closeOpenClawAgentDatabasesAsync();
  await drainGlobalSingletonLifecycleState("shared-state");
} catch (error) {
  closeError = error;
}
const elapsedMs = performance.now() - start;
const cpuUsed = process.cpuUsage(cpu);
const { profile } = await inspector.post("HeapProfiler.stopSampling");
inspector.disconnect();
const nodes = [profile.head];
let sampledBytes = 0;
while (nodes.length) {
  const node = nodes.pop();
  sampledBytes += node.selfSize;
  nodes.push(...node.children);
}
const exitCode = cleanup.finish(0, closeError ? [closeError] : []);
const result = {
  source,
  shape,
  elapsedMs,
  cpuMs: (cpuUsed.user + cpuUsed.system) / 1000,
  sampledBytes,
  exitCode,
  errors,
  workOutcome: await workOutcome,
  load: loadavg(),
};
// Outside measurement, retry failed baseline custody so fixtures and workers are joined.
await state.closeOpenClawStateDatabaseAsync();
const reopened = state.openOpenClawStateDatabase({ env: process.env });
assert.equal(
  reopened.db
    .prepare("SELECT count(*) AS n FROM state_leases WHERE scope = ?")
    .get("core:shutdown-measure").n,
  0,
);
await drainGlobalSingletonLifecycleState();
await closeDefaultRetainedNativeWorkerSource();
await writeFile(values.output, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify(result));
process.exitCode = exitCode;
