/** Real registry/SQLite lifetime shared by cancellation ownership regressions. */
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { cleanupBrowserSessionsForLifecycleEnd } from "../../../browser-lifecycle-cleanup.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../../config/config.js";
import { setRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import {
  applySessionEntryLifecycleMutation,
  listSessionEntriesCore,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { LegacyContextEngine } from "../../../context-engine/legacy.js";
import { resolveContextEngine } from "../../../context-engine/registry.js";
import { callGateway } from "../../../gateway/call.js";
import { flushLogger, resetLogger } from "../../../logging/logger.js";
import { getActiveGatewayRootWorkCount } from "../../../process/gateway-work-admission.js";
import { closeOpenClawAgentDatabasesAsync } from "../../../state/openclaw-agent-db.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import type { DomainScope } from "../../../state/openclaw-state-worker-store.types.js";
import { captureEnv, setTestEnvValue, withEnvAsync } from "../../../test-utils/env.js";
import {
  cleanupSessionStateForTest,
  drainSessionStateForTest,
} from "../../../test-utils/session-state-cleanup.js";
import { loadAgentRuntimePluginRegistryHandle } from "../../runtime-plugins.js";
import { isSubagentRegistryWriteCommand } from "../../subagent-test-fixtures.test-helpers.js";
import {
  captureSubagentCompletionReply,
  runSubagentAnnounceFlow,
} from "../announce/subagent-announce.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "../announce/subagent-announce.requester-settle-wake.js";
import { observeSwarmSchedulerWork } from "../swarm/swarm-scheduler.lifecycle.test-support.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";
import { settleSubagentRegistryPersistenceWork } from "./subagent-registry.persistence.test-support.js";
import { rowToSubagentRunRecord } from "./subagent-registry.store.codec.js";
import { resetSubagentRegistryForTests } from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

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
vi.mock("../../../state/openclaw-state-worker-store.js", { spy: true });

// Fault gates delegate to the native worker; it owns admission, transactions, and receipts.
export const { runOpenClawStateWorkerOperation: runSubagentStateWorkerOperation } =
  await vi.importActual<typeof stateWorker>("../../../state/openclaw-state-worker-store.js");

export function useSubagentControlFixture(options: { reuseStateDir?: boolean } = {}) {
  const env = captureEnv(["OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"]);
  let stateDir = "";
  let caseState: "idle" | "active" | "failed" = "idle";
  let settleRootWork: ReturnType<typeof observeRootWork>;
  let schedulerWork: ReturnType<typeof observeSwarmSchedulerWork>;
  const settle = (keepObserving = true) =>
    settleSubagentRegistryPersistenceWork(() => settleRootWork(keepObserving));
  const worker = vi.mocked(stateWorker.runOpenClawStateWorkerOperation);
  const gateway = vi.mocked(callGateway);
  const announce = vi.mocked(runSubagentAnnounceFlow);
  const capture = vi.mocked(captureSubagentCompletionReply);
  const wake = vi.mocked(maybeWakeRequesterAfterAllChildrenSettled);
  const cleanup = vi.mocked(cleanupBrowserSessionsForLifecycleEnd);
  const pluginRuntime = vi.mocked(loadAgentRuntimePluginRegistryHandle);
  const contextEngine = vi.mocked(resolveContextEngine);
  beforeEach(async () => {
    if (options.reuseStateDir && caseState !== "idle") {
      throw new Error("Previous subagent control fixture cleanup is incomplete");
    }
    schedulerWork = observeSwarmSchedulerWork();
    caseState = "active";
    if (!options.reuseStateDir || !stateDir) {
      stateDir = await realpath(
        await mkdtemp(path.join(os.tmpdir(), "openclaw-ancestor-retirement-")),
      );
    }
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    setTestEnvValue("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
    const config: OpenClawConfig = { agents: { defaults: { workspace: stateDir } } };
    await writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify(config));
    clearConfigCache();
    clearRuntimeConfigSnapshot();
    setRuntimeConfigSnapshot(config);
    await resetSubagentRegistryForTests({ persist: false });
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
    worker.mockReset().mockImplementation(runSubagentStateWorkerOperation);
    settleRootWork = observeRootWork();
  });
  afterEach(async () => {
    if (options.reuseStateDir && caseState !== "active") {
      return;
    }
    const failures: unknown[] = [];
    let schedulerClosed = false;
    try {
      await schedulerWork.close();
      schedulerClosed = true;
    } catch (error) {
      failures.push(error);
    }
    try {
      await settle(false);
    } catch (error) {
      failures.push(error);
    } finally {
      vi.restoreAllMocks();
    }
    // Preserve stores and their environment if detached writers have not settled.
    if (schedulerClosed && getActiveGatewayRootWorkCount() === 0) {
      try {
        // Shared fixtures clear durable rows through the registry owner before reusing workers.
        if (options.reuseStateDir) {
          worker.mockReset().mockImplementation(runSubagentStateWorkerOperation);
        }
        await resetSubagentRegistryForTests({ persist: options.reuseStateDir === true });
        if (options.reuseStateDir) {
          await drainSessionStateForTest({ stateDir });
          const target = {
            agentId: "main",
            storePath: path.join(stateDir, "agents", "main", "sessions", "sessions.json"),
          };
          const removals = listSessionEntriesCore(target).map(({ sessionKey }) => ({
            sessionKey,
            deleteOwnedWindows: true,
          }));
          if (removals.length > 0) {
            await applySessionEntryLifecycleMutation({
              ...target,
              removals,
              skipMaintenance: true,
            });
            await drainSessionStateForTest({ stateDir });
          }
        } else {
          await cleanupSessionStateForTest({ stateDir });
        }
        for (const mock of [
          worker,
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
        if (!options.reuseStateDir) {
          await rm(stateDir, { recursive: true, force: true });
        }
        env.restore();
        caseState = "idle";
      } catch (error) {
        failures.push(error);
      }
    }
    if (caseState === "active") {
      caseState = "failed";
    }
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "Subagent control fixture cleanup failed");
    }
  });

  afterAll(async () => {
    if (
      options.reuseStateDir &&
      stateDir &&
      caseState === "idle" &&
      getActiveGatewayRootWorkCount() === 0
    ) {
      await withEnvAsync(
        {
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
        },
        async () => {
          await cleanupSessionStateForTest({ stateDir });
          await rm(stateDir, { recursive: true, force: true });
        },
      );
    }
  });

  return {
    settle,
    get stateDir() {
      return stateDir;
    },
    worker,
    interceptWorkerCommand(
      intercept: (command: Parameters<DomainScope["execute"]>[0]) => void | Promise<void>,
      phase: "before" | "after" = "before",
    ) {
      worker.mockImplementation((context, operation, operationOptions) =>
        runSubagentStateWorkerOperation(
          context,
          (scope) =>
            operation({
              ...scope,
              execute: async (command, executeOptions) => {
                const before = phase === "before" ? intercept(command) : undefined;
                if (before) {
                  await before;
                }
                const result = await scope.execute(command, executeOptions);
                const after = phase === "after" ? intercept(command) : undefined;
                if (after) {
                  await after;
                }
                return result;
              },
            }),
          operationOptions,
        ),
      );
    },
    rejectRegistryWrites(reject: (row: SubagentRunRecord) => boolean, message: string) {
      worker.mockImplementation((context, operation, operationOptions) =>
        runSubagentStateWorkerOperation(
          context,
          (scope) =>
            operation({
              execute: async (command, executeOptions) => {
                if (
                  isSubagentRegistryWriteCommand(command) &&
                  command.input.values.some((value) => {
                    const row = rowToSubagentRunRecord(value);
                    return row !== null && reject(row);
                  })
                ) {
                  throw new Error(message);
                }
                return scope.execute(command, executeOptions);
              },
            }),
          operationOptions,
        ),
      );
    },
    gateway,
    announce,
    capture,
    wake,
    cleanup,
  };
}

export function useSubagentControlSessionStores() {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterAll(async () => {
      await closeOpenClawAgentDatabasesAsync(tempRoot);
      cleanup();
    }),
  );
  const tempRoot = tempDirs.make("openclaw-subagent-control-");
  let tempStoreIndex = 0;

  function nextSessionStorePath(label: string) {
    tempStoreIndex += 1;
    return path.join(tempRoot, `${tempStoreIndex}-${label}.json`);
  }

  function cfgWithSessionStore(storePath = nextSessionStorePath("sessions")): OpenClawConfig {
    return {
      session: { store: storePath },
    } as OpenClawConfig;
  }

  async function writeSessionStoreFixture(label: string, store: Record<string, unknown>) {
    const storePath = nextSessionStorePath(label);
    for (const [sessionKey, entry] of Object.entries(store)) {
      const record = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
      const sessionId =
        typeof record.sessionId === "string" && record.sessionId.trim()
          ? record.sessionId
          : `sess-${sessionKey.replaceAll(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")}`;
      await replaceSessionEntry({ storePath, sessionKey }, {
        ...record,
        sessionId,
      } as SessionEntry);
    }
    return storePath;
  }

  return { cfgWithSessionStore, writeSessionStoreFixture };
}
