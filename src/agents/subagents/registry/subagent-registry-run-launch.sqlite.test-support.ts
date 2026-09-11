import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  getRuntimeConfig,
} from "../../../config/config.js";
import type {
  GatewayRequestContext,
  GatewayRequestOptions,
} from "../../../gateway/server-methods/types.js";
import { resetGatewayWorkAdmission } from "../../../process/gateway-work-admission.js";
import { closeOpenClawStateDatabaseForTest } from "../../../state/openclaw-state-db.js";
import { resetDetachedTaskLifecycleRuntimeForTests } from "../../../tasks/detached-task-runtime.test-support.js";
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "../../../tasks/task-runtime.test-helpers.js";
import { findTaskByRunIdForStatus } from "../../../tasks/task-status-access.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import { testing as subagentSpawnTesting } from "../spawn/subagent-spawn.test-support.js";
import { testing as swarmSchedulerTesting } from "../swarm/swarm-scheduler.test-support.js";
import { registerSubagentRun } from "./subagent-registry.js";
import {
  createSubagentRegistryTestDeps,
  settleSubagentRegistryPersistenceWork,
} from "./subagent-registry.persistence.test-support.js";
import { saveSubagentRegistryToSqlite } from "./subagent-registry.store.sqlite.js";
import { resetSubagentRegistryForTests, testing } from "./subagent-registry.test-helpers.js";

export function useQueuedCollectorAcceptanceStorageFixture() {
  const env = captureEnv([
    "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE",
  ]);
  let stateDir = "";

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-collector-acceptance-"));
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    setTestEnvValue("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
    setTestEnvValue("OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE", "1");
    await writeFile(
      path.join(stateDir, "openclaw.json"),
      `${JSON.stringify({
        session: { mainKey: "main", scope: "per-sender" },
        tools: { swarm: { enabled: true, maxConcurrent: 1 } },
        agents: { defaults: { workspace: stateDir }, entries: { main: { workspace: stateDir } } },
      })}\n`,
    );
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    resetGatewayWorkAdmission();
    swarmSchedulerTesting.reset();
    resetSubagentRegistryForTests({ persist: false });
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    testing.setDepsForTest({
      ...createSubagentRegistryTestDeps(),
      persistSubagentRunsToDisk: saveSubagentRegistryToSqlite,
      callGateway: async <T>() => ({ status: "pending" }) as T,
    });
  });

  afterEach(async () => {
    await settleSubagentRegistryPersistenceWork();
    resetSubagentRegistryForTests({ persist: false });
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    resetDetachedTaskLifecycleRuntimeForTests();
    testing.setDepsForTest();
    subagentSpawnTesting.setDepsForTest();
    resetGatewayWorkAdmission();
    swarmSchedulerTesting.reset();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    closeOpenClawStateDatabaseForTest();
    await rm(stateDir, { recursive: true, force: true });
    env.restore();
  });

  return {
    makeGatewayContext: () =>
      ({
        logGateway: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        getRuntimeConfig,
      }) as unknown as GatewayRequestContext,
    externalCliClient: () =>
      ({
        connect: {
          minProtocol: 1,
          maxProtocol: 1,
          client: { id: "cli", version: "test", platform: "test", mode: "cli" },
          scopes: ["operator.write"],
        },
      }) as GatewayRequestOptions["client"],
    registerPreparedCollector: (runId: string) => {
      registerSubagentRun({
        runId,
        childSessionKey: `agent:main:subagent:${runId}`,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "atomic collector acceptance",
        cleanup: "keep",
        collect: true,
        groupId: "atomic-acceptance",
        queued: true,
        taskRowOwnership: "required",
        expectsCompletionMessage: false,
      });
      return findTaskByRunIdForStatus(runId)!;
    },
  };
}
