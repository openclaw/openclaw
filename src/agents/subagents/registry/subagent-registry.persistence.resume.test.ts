import { setImmediate as nextTask } from "node:timers/promises";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "./subagent-registry.persistence.mocks.test-support.js";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  activateSubagentPersistenceRegistry,
  announceSpy,
  closeSubagentPersistenceFixtureDatabases,
  resetSubagentPersistenceGatewayCalls,
} from "./subagent-registry.persistence-fixture.test-support.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../../config/config.js";
import "./subagent-registry.mocks.shared.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import {
  loadSubagentRegistryFromSqlite,
  saveSubagentRegistryToSqlite,
} from "./subagent-registry-state.fixture.test-support.js";
import { registerSubagentDismissedRetentionCases } from "./subagent-registry.persistence.retention.test-support.js";
import {
  withSubagentRegistryPersistenceState,
  createOrphanedRequiredDelivery,
} from "./subagent-registry.persistence.test-support.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let mod: typeof import("./subagent-registry.test-helpers.js");
let callGatewayModule: typeof import("../../../gateway/call.js");
let agentEventsModule: typeof import("../../../infra/agent-events.js");
let registryConfigModule: typeof import("../../../config/config.js");
let registrySessionCleanupModule: typeof import("../../../test-utils/session-state-cleanup.js");
let registryAgentDbTestModule: typeof import("../../../state/openclaw-agent-db.test-support.js");
let registryStateDbModule: typeof import("../../../state/openclaw-state-db.js");
let observeRootWork: typeof import("./subagent-registry.browser-cleanup.test-support.js").observeRootWork;
let settleOwnedWork: ReturnType<typeof observeRootWork> | undefined;

const readPersistedRun = (runId: string) => loadSubagentRegistryFromSqlite().get(runId);

describe("subagent registry metadata hydration", () => {
  beforeAll(async () => {
    vi.resetModules();
    mod = await import("./subagent-registry.test-helpers.js");
    callGatewayModule = await import("../../../gateway/call.js");
    agentEventsModule = await import("../../../infra/agent-events.js");
    registryStateDbModule = await import("../../../state/openclaw-state-db.js");
    registryConfigModule = await import("../../../config/config.js");
    registryAgentDbTestModule = await import("../../../state/openclaw-agent-db.test-support.js");
    registrySessionCleanupModule = await import("../../../test-utils/session-state-cleanup.js");
    ({ observeRootWork } = await import("./subagent-registry.browser-cleanup.test-support.js"));
  });

  beforeEach(async () => {
    settleOwnedWork = observeRootWork();
    setRuntimeConfigSnapshot({});
    registryConfigModule.setRuntimeConfigSnapshot({});
    announceSpy.mockClear();
    resetSubagentPersistenceGatewayCalls(callGatewayModule.callGateway);
    await mod.resetSubagentRegistryForTests({ persist: false });
    vi.mocked(agentEventsModule.onAgentEvent)
      .mockReset()
      .mockReturnValue(() => undefined);
  });

  afterEach(async () => {
    try {
      await settleOwnedWork?.();
    } finally {
      settleOwnedWork = undefined;
      vi.restoreAllMocks();
      clearRuntimeConfigSnapshot();
      registryConfigModule.clearRuntimeConfigSnapshot();
    }
  });

  const withRegistryState = <T>(run: (stateDir: string) => Promise<T>) => {
    const stateDir = tempDirs.make("openclaw-subagent-");
    return withSubagentRegistryPersistenceState(
      {
        stateDir,
        resetRegistry: () => mod.resetSubagentRegistryForTests({ persist: false }),
        settleOwnedWork: () => settleOwnedWork?.(true),
        closeDatabases: () =>
          closeSubagentPersistenceFixtureDatabases({
            stateDir,
            cleanupSessionState: registrySessionCleanupModule.cleanupSessionStateForTest,
            listAgentDatabases: registryAgentDbTestModule.listOpenClawAgentDatabasesForTest,
            closeStateDatabase: registryStateDbModule.closeOpenClawStateDatabaseForTest,
          }),
      },
      () => run(stateDir),
    );
  };

  const activateRegistry = () =>
    activateSubagentPersistenceRegistry(mod, callGatewayModule.callGateway);
  const restoreRegistry = async () => {
    await mod.initSubagentRegistry();
    await activateRegistry();
  };
  const saveRuns = (...runs: SubagentRunRecord[]) =>
    saveSubagentRegistryToSqlite(new Map(runs.map((run) => [run.runId, run])));
  it("restores metadata without reloading unchanged retained payloads", async () => {
    await withRegistryState(async () => {
      const endedAt = 1_000;
      const runs = ["unchanged", "retention-changed"].map((runId) =>
        createSubagentRunRecord({
          runId,
          childAgentId: "main",
          requesterAgentId: "main",
          childSessionKey: `agent:main:subagent:${runId}`,
          task: "retained task ".repeat(100),
          endedAt,
          cleanup: "delete",
          cleanupCompletedAt: endedAt,
          archiveAtMs: runId === "unchanged" ? endedAt + 60_000 : endedAt + 120_000,
          delivery: { status: "delivered" },
          completion: { required: true, resultText: "retained result ".repeat(100) },
        }),
      );
      registryConfigModule.setRuntimeConfigSnapshot({
        agents: { defaults: { subagents: { archiveAfterMinutes: 1 } } },
      });
      saveRuns(...runs);
      const reads = await import("./subagent-registry-read-cache.js");
      const payloadReads = vi.spyOn(reads, "readFullSubagentRuns");

      await mod.initSubagentRegistry();

      expect(payloadReads.mock.calls.map(([, selection]) => selection)).toEqual([
        { kind: "ids", runIds: ["retention-changed"] },
      ]);
      for (const original of runs) {
        expect(readPersistedRun(original.runId)).toMatchObject({
          archiveAtMs: endedAt + 60_000,
          task: original.task,
          completion: original.completion,
        });
      }
    });
  });

  it.each([
    { status: "suspended" as const, disposition: undefined, queueId: undefined },
    { status: "in_progress" as const, disposition: "session_queued" as const, queueId: "queue-1" },
  ])("retains $status required delivery with its owner after restart", async (expected) => {
    await withRegistryState(async () => {
      const run = createOrphanedRequiredDelivery(expected.status);
      run.completion = {
        ...run.completion,
        required: true,
        resultText: "retained result ".repeat(2_048),
      };
      saveRuns(run);

      await restoreRegistry();
      await nextTask();

      expect(announceSpy).not.toHaveBeenCalled();
      expect(mod.getSubagentRunByRunId(run.runId)?.completion).toEqual(run.completion);
      expect(readPersistedRun(run.runId)?.completion).toEqual(run.completion);
      expect(readPersistedRun(run.runId)?.delivery).toMatchObject({
        status: expected.status,
        ...(expected.disposition ? { disposition: expected.disposition } : {}),
        ...(expected.queueId ? { queueId: expected.queueId } : {}),
      });
    });
  });

  registerSubagentDismissedRetentionCases({
    getRegistry: () => mod,
    withRegistryState,
    announceSpy,
  });
});
