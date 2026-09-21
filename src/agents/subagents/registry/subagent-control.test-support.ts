/** Real registry/SQLite lifetime shared by cancellation ownership regressions. */
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../../config/config.js";
import { LegacyContextEngine } from "../../../context-engine/legacy.js";
import { flushLogger, resetLogger } from "../../../logging/logger.js";
import { revokePluginRecord } from "../../../plugins/registry-lifecycle.js";
import { requireActivePluginRegistry } from "../../../plugins/runtime.js";
import { createPluginRecord } from "../../../plugins/status.test-helpers.js";
import type { DetachedTaskLifecycleRuntime } from "../../../tasks/detached-task-runtime-contract.js";
import { resetDetachedTaskLifecycleRuntimeForTests } from "../../../tasks/detached-task-runtime.test-support.js";
import { resetTaskFlowRegistryForTests } from "../../../tasks/task-flow-registry.test-support.js";
import { resetTaskRegistryForTests } from "../../../tasks/task-registry.test-support.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../../test-utils/session-state-cleanup.js";
import { testing as schedulerTesting } from "../swarm/swarm-scheduler.test-support.js";
import { SubagentRegistryWriteError } from "./subagent-registry-persistence.js";
import { persistSubagentRunsToDiskOrThrow } from "./subagent-registry-state.js";
import { settleSubagentRegistryPersistenceWork } from "./subagent-registry.persistence.test-support.js";
import { resetSubagentRegistryForTests, testing } from "./subagent-registry.test-helpers.js";

export function useSubagentControlFixture() {
  const env = captureEnv(["OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"]);
  let stateDir = "";
  const persist = vi.fn(persistSubagentRunsToDiskOrThrow);
  const gateway = vi.fn(async (request: { method: string }) => {
    if (request.method !== "agent.wait") {
      throw new Error(`Unexpected registry RPC ${request.method}`);
    }
    return await new Promise<never>(() => {});
  });
  beforeEach(async () => {
    stateDir = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "openclaw-ancestor-retirement-")),
    );
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    setTestEnvValue("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
    await writeFile(
      path.join(stateDir, "openclaw.json"),
      JSON.stringify({ agents: { defaults: { workspace: stateDir } } }),
    );
    clearConfigCache();
    clearRuntimeConfigSnapshot();
    resetSubagentRegistryForTests({ persist: false });
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    gateway.mockReset();
    persist.mockReset().mockImplementation(persistSubagentRunsToDiskOrThrow);
    testing.setDepsForTest({
      cleanupBrowserSessionsForLifecycleEnd: async () => {},
      loadAgentRuntimePluginRegistryHandle: () => undefined,
      resolveContextEngine: async () => new LegacyContextEngine(),
      callGateway: gateway,
      persistSubagentRunsToDiskOrThrow: persist,
      // Control fixtures inject their transaction faults through one persistence owner.
      persistSubagentRunsToDiskAsyncOrThrow: async (runs, ids, options) => {
        const snapshot = structuredClone(runs);
        await Promise.resolve();
        let committed = false;
        try {
          options.assertCurrent?.();
          persist(snapshot, ids);
          committed = true;
          options.onCommitted?.();
        } catch (error) {
          throw new SubagentRegistryWriteError(committed ? "committed" : "not-committed", error);
        }
      },
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await settleSubagentRegistryPersistenceWork();
    resetSubagentRegistryForTests({ persist: false });
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    schedulerTesting.reset();
    resetDetachedTaskLifecycleRuntimeForTests();
    await cleanupSessionStateForTest({ stateDir });
    testing.setDepsForTest();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    await flushLogger();
    resetLogger();
    await rm(stateDir, { recursive: true, force: true });
    env.restore();
  });

  return {
    get stateDir() {
      return stateDir;
    },
    persist,
    gateway,
    useTaskRuntime(runtime: DetachedTaskLifecycleRuntime) {
      const registry = requireActivePluginRegistry();
      const previous = [...registry.detachedTaskRuntimes];
      const record = createPluginRecord({ id: "subagent-control-task-fixture" });
      registry.plugins.push(record);
      registry.detachedTaskRuntimes.splice(0, registry.detachedTaskRuntimes.length, {
        pluginId: record.id,
        runtime,
      });
      return () => {
        registry.detachedTaskRuntimes.splice(0, registry.detachedTaskRuntimes.length, ...previous);
        revokePluginRecord(registry, record);
        const index = registry.plugins.indexOf(record);
        if (index >= 0) {
          registry.plugins.splice(index, 1);
        }
      };
    },
  };
}
