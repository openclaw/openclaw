/** Real registry/SQLite lifetime shared by cancellation ownership regressions. */
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import { cleanupBrowserSessionsForLifecycleEnd } from "../../../browser-lifecycle-cleanup.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../../config/config.js";
import { LegacyContextEngine } from "../../../context-engine/legacy.js";
import { resolveContextEngine } from "../../../context-engine/registry.js";
import { callGateway } from "../../../gateway/call.js";
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
import { loadAgentRuntimePluginRegistryHandle } from "../../runtime-plugins.js";
import {
  captureSubagentCompletionReply,
  runSubagentAnnounceFlow,
} from "../announce/subagent-announce.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "../announce/subagent-announce.requester-settle-wake.js";
import { testing as schedulerTesting } from "../swarm/swarm-scheduler.test-support.js";
import { SubagentRegistryWriteError } from "./subagent-registry-persistence.js";
import * as registryState from "./subagent-registry-state.js";
import { settleSubagentRegistryPersistenceWork } from "./subagent-registry.persistence.test-support.js";
import { resetSubagentRegistryForTests } from "./subagent-registry.test-helpers.js";

vi.mock("../../../browser-lifecycle-cleanup.js", { spy: true });
vi.mock("../../../context-engine/registry.js", { spy: true });
vi.mock("../../../gateway/call.js", { spy: true });
vi.mock("../../runtime-plugins.js", async () => {
  const { getActivePluginRegistry } = await import("../../../plugins/runtime.js");
  const { createEmptyPluginRegistry } = await import("../../../plugins/registry-empty.js");
  return {
    loadAgentRuntimePluginRegistryHandle: vi.fn<typeof loadAgentRuntimePluginRegistryHandle>(
      () => getActivePluginRegistry() ?? createEmptyPluginRegistry(),
    ),
  };
});
vi.mock("../announce/subagent-announce.js", { spy: true });
vi.mock("../announce/subagent-announce.requester-settle-wake.js", { spy: true });
vi.mock("./subagent-registry-state.js", { spy: true });

// Fault callbacks must delegate to the real writer, never their own mocked export.
export const { persistSubagentRunsToDiskOrThrow } = await vi.importActual<typeof registryState>(
  "./subagent-registry-state.js",
);

export function useSubagentControlFixture() {
  const env = captureEnv(["OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"]);
  let stateDir = "";
  const persist = vi.mocked(registryState.persistSubagentRunsToDiskOrThrow);
  const persistAsync = vi.mocked(registryState.persistSubagentRunsToDiskAsyncOrThrow);
  const gateway = vi.mocked(callGateway);
  const announce = vi.mocked(runSubagentAnnounceFlow);
  const capture = vi.mocked(captureSubagentCompletionReply);
  const wake = vi.mocked(maybeWakeRequesterAfterAllChildrenSettled);
  const cleanup = vi.mocked(cleanupBrowserSessionsForLifecycleEnd);
  const pluginRuntime = vi.mocked(loadAgentRuntimePluginRegistryHandle);
  const contextEngine = vi.mocked(resolveContextEngine);
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
    gateway.mockReset().mockImplementation(async (request) => {
      if (request.method !== "agent.wait") {
        throw new Error(`Unexpected registry RPC ${request.method}`);
      }
      return await new Promise<never>(() => {});
    });
    announce.mockReset();
    capture.mockReset();
    wake.mockReset();
    cleanup.mockReset().mockResolvedValue(undefined);
    pluginRuntime.mockReset();
    contextEngine.mockReset().mockImplementation(async () => new LegacyContextEngine());
    persist.mockReset().mockImplementation(persistSubagentRunsToDiskOrThrow);
    // Control fixtures inject their transaction faults through one persistence owner.
    persistAsync.mockReset().mockImplementation(async (runs, ids, options) => {
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
    for (const mock of [
      persist,
      persistAsync,
      gateway,
      announce,
      capture,
      wake,
      cleanup,
      pluginRuntime,
      contextEngine,
    ]) {
      mock.mockReset();
    }
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
    announce,
    capture,
    wake,
    cleanup,
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
