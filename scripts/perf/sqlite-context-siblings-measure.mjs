// Entry census only; instrumented results are not CPU/allocation measurements.
// node --import ./scripts/tsx.mjs scripts/perf/sqlite-context-siblings-measure.mjs [iterations=100]
// Seeds 1,000 synthetic workspace records, then verifies two warm write arms through
// the actual SQLite worker. No schema-maintenance or plugin invocation is simulated.
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

mkdirSync(".local", { recursive: true });
const fixture = mkdtempSync(path.resolve(".local/sqlite-context-siblings-"));
Object.assign(process.env, {
  OPENCLAW_STATE_DIR: fixture,
  OPENCLAW_HOME: path.join(fixture, "home"),
  OPENCLAW_CONFIG_PATH: path.join(fixture, "config.json"),
  OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
});

const { createEmbeddedAttemptTranscriptLifecycle } =
  await import("../../src/agents/embedded-agent-runner/run/attempt-transcript-lifecycle.ts");
const { withPluginRuntimeGatewayRequestScope } =
  await import("../../src/plugins/runtime/gateway-request-scope.ts");
const { captureOpenClawStateWorkerContext } =
  await import("../../src/state/openclaw-state-worker-context.ts");
const { executeOpenClawStateWorker } =
  await import("../../src/state/openclaw-state-worker-store.ts");
const { writeConfigMachineState } = await import("../../src/state/config-machine-state-write.ts");
const { closeOpenClawStateDatabaseAsync } =
  await import("../../src/state/openclaw-state-db-cache.ts");
const { executeExistingOpenClawStateRead } =
  await import("../../src/state/openclaw-state-db-readonly.ts");

let counters;
const stack = () =>
  new Error().stack
    .split("\n")
    .slice(3, 8)
    .map((line) => line.trim())
    .join("\n");
const add = (kind, owner) => {
  if (!counters) {
    return;
  }
  counters[kind] ??= {};
  counters[kind][owner] = (counters[kind][owner] ?? 0) + 1;
};
// eslint-disable-next-line @typescript-eslint/unbound-method -- Instrumentation restores the exact method and supplies the original receiver with call().
const originalEnterWith = AsyncLocalStorage.prototype.enterWith;
// eslint-disable-next-line @typescript-eslint/unbound-method -- Instrumentation restores the exact method and supplies the original receiver with call().
const originalRun = AsyncLocalStorage.prototype.run;
// eslint-disable-next-line @typescript-eslint/unbound-method -- Native static snapshot is restored after the diagnostic pass.
const originalSnapshot = AsyncLocalStorage.snapshot;
const originalKeys = Object.keys;
AsyncLocalStorage.prototype.enterWith = function (value) {
  add(this.getStore() === value ? "enterWithSame" : "enterWithChanged", stack());
  return originalEnterWith.call(this, value);
};
AsyncLocalStorage.prototype.run = function (value, run, ...args) {
  add(this.getStore() === value ? "runSame" : "runChanged", stack());
  return originalRun.call(this, value, run, ...args);
};
AsyncLocalStorage.snapshot = function () {
  const captured = originalSnapshot.call(AsyncLocalStorage);
  const owner = stack();
  add("snapshotCreated", owner);
  return (run, ...args) => {
    add("snapshotRestored", owner);
    return captured(run, ...args);
  };
};
Object.keys = function (object) {
  if (counters) {
    const owner = stack();
    if (owner.includes("copyGatewayScope")) {
      add("copyGatewayScope", owner);
    }
  }
  return originalKeys(object);
};

const iterations = Number(process.argv[2] ?? 100);
assert(Number.isSafeInteger(iterations) && iterations > 0 && iterations <= 1000);
const rows = [];
const sourceHashes = Object.fromEntries(
  [
    "src/state/openclaw-state-worker-store.ts",
    "src/state/openclaw-state-worker-operation.ts",
    "src/infra/sqlite-worker-operation-admission.ts",
    "src/agents/embedded-agent-runner/run/attempt-transcript-lifecycle.ts",
  ].map((file) => [file, createHash("sha256").update(readFileSync(file)).digest("hex")]),
);
async function measure(label, run) {
  counters = {};
  try {
    await run();
  } finally {
    rows.push({ label, iterations, counters });
    counters = undefined;
  }
}
try {
  await withPluginRuntimeGatewayRequestScope(
    { isWebchatConnect: () => false, pluginId: "synthetic-probe" },
    async () => {
      const lifecycle = createEmbeddedAttemptTranscriptLifecycle({ runId: "synthetic-probe" });
      for (let index = 0; index < 20; index++) {
        await lifecycle.withTranscriptWrite(() => undefined);
      }
      await measure("lifecycle-direct", async () => {
        for (let index = 0; index < iterations; index++) {
          await lifecycle.withTranscriptWrite(() => undefined);
        }
      });
      await measure("lifecycle-nested", async () => {
        for (let index = 0; index < iterations; index++) {
          await lifecycle.withTranscriptWrite(() => lifecycle.withTranscriptWrite(() => undefined));
        }
      });
      await lifecycle.dispose();
      const options = { env: process.env, path: path.join(fixture, "openclaw.sqlite") };
      writeConfigMachineState("synthetic.probe", { fixture: true }, options);
      const context = captureOpenClawStateWorkerContext(options);
      const execute = (index) =>
        executeOpenClawStateWorker(context, {
          type: "onboardingRecommendations.writeOffer",
          input: {
            workspaceKey: `synthetic-workspace-${index % 1000}`,
            params: { inventoryHash: "synthetic", matches: [], answered: false, nowMs: index + 1 },
          },
        });
      for (let index = 0; index < 1000; index++) {
        await execute(index);
      }
      for (const arm of [0, 1]) {
        await measure(`shared-state-warm-write-A${arm + 1}`, async () => {
          for (let index = 0; index < iterations; index++) {
            const reply = await execute(1000 * (arm + 1) + index);
            assert.equal(reply.updatedAt, 1000 * (arm + 1) + index + 1);
          }
        });
      }
      const persisted = await executeExistingOpenClawStateRead(options, {
        type: "onboardingRecommendations.read",
        configKey: `onboarding.recommendations.synthetic-workspace-${(iterations - 1) % 1000}`,
      });
      assert.equal(persisted.record.updatedAt, 2000 + iterations);
    },
  );
} finally {
  counters = undefined;
  AsyncLocalStorage.prototype.enterWith = originalEnterWith;
  AsyncLocalStorage.prototype.run = originalRun;
  AsyncLocalStorage.snapshot = originalSnapshot;
  Object.keys = originalKeys;
  await closeOpenClawStateDatabaseAsync();
  const result = {
    node: process.version,
    fixture,
    sourceHashes,
    syntheticWorkspaceRows: 1000,
    rows,
  };
  rmSync(fixture, { recursive: true, force: true });
  console.log(JSON.stringify(result));
}
