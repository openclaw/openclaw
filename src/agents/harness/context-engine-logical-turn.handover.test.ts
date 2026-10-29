import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { LegacyContextEngine } from "../../context-engine/legacy.js";
import { registerContextEngineInRegistry } from "../../context-engine/registry.js";
import { resetContextEngineRuntimeQuarantineForTests } from "../../context-engine/registry.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createContextEngineLogicalTurnLease } from "./context-engine-logical-turn.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const engineId = "swap-engine";
const config = { plugins: { slots: { contextEngine: engineId } } };
const identity = { runId: "handover-run", sessionId: "handover-session" };

beforeEach(async () => {
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("context-engine-handover-"));
  await resetContextEngineRuntimeQuarantineForTests();
});
afterEach(async () => {
  await resetContextEngineRuntimeQuarantineForTests();
  vi.unstubAllEnvs();
});

// One plugin generation: its registry and the engines its factory created and disposed.
function generation(name: string, registersEngine = true) {
  const registry = createEmptyPluginRegistry();
  const disposed: string[] = [];
  registerContextEngineInRegistry(registry, "legacy", () => new LegacyContextEngine(), "core");
  if (registersEngine) {
    registerContextEngineInRegistry(
      registry,
      engineId,
      () =>
        Object.assign(new LegacyContextEngine(), {
          info: { id: engineId, name },
          dispose: async () => {
            disposed.push(name);
          },
        }),
      `plugin:${engineId}`,
    );
  }
  return { registry, disposed };
}

it("hands a started turn's engine to the current generation and settles the turn once", async () => {
  const first = generation("first");
  const second = generation("second");
  const settle = vi.fn(async () => undefined);
  const lease = await withPluginRuntimeRegistryScope(first.registry, () =>
    createContextEngineLogicalTurnLease({ identity, config }),
  );
  lease.begin();
  lease.onDispose("admission", settle);

  // The old engine is released at once, but the turn's settlements wait for its end.
  await lease.handOver();
  expect(first.disposed).toEqual(["first"]);
  expect(settle).not.toHaveBeenCalled();

  await withPluginRuntimeRegistryScope(second.registry, () => lease.rebind());
  expect(lease.begin().engine.info.name).toBe("second");
  expect(lease.effectiveEngineId).toBe(engineId);

  await lease.dispose();
  expect(settle).toHaveBeenCalledOnce();
  expect(first.disposed).toEqual(["first"]);
  expect(second.disposed).toEqual(["second"]);
});

it("fails the turn closed when the new generation no longer registers its engine", async () => {
  const first = generation("first");
  const second = generation("second", false);
  const lease = await withPluginRuntimeRegistryScope(first.registry, () =>
    createContextEngineLogicalTurnLease({ identity, config }),
  );
  lease.begin();
  await lease.handOver();

  await expect(
    withPluginRuntimeRegistryScope(second.registry, () => lease.rebind()),
  ).rejects.toThrow(`context engine "${engineId}" is unavailable after plugin reload`);
  await lease.dispose();
  expect(first.disposed).toEqual(["first"]);
});
