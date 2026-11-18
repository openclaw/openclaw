import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import {
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import { resetHeartbeatEventsForTest } from "../../../infra/heartbeat-events.js";
import { publishSystemEventStoreResolver } from "../../../infra/system-event-ownership.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../../state/openclaw-state-db.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import {
  blockSubagentCompletionDelivery,
  mutateRequesterCompletionBatch,
} from "../completion/subagent-completion-admission.store.js";
import {
  records,
  seedSubagentCompletionDelivery,
} from "../completion/subagent-completion-admission.test-helpers.js";
import { subagentRegistryLog } from "./subagent-registry-lifecycle-log.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { restoreSubagentRunsFromDisk } from "./subagent-registry-persistence.js";
import { markSubagentRunPausedAfterYield } from "./subagent-registry-run-pause.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
import { publishSubagentRunsAfterAtomicStore } from "./subagent-registry-state.js";
import { settleUnreachableYieldedSubagentRun } from "./subagent-registry-sweep-settle.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";
import { resetSubagentRegistryForTests, testing } from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function publishCommittedRecords(row: SubagentRunRecord): void {
  seedSubagentCompletionDelivery({ subagent: row });
  subagentRuns.set(row.runId, row);
  publishSubagentRunsAfterAtomicStore(subagentRuns, [row.runId])();
}

it.each(["delivered", "failed", "error-failed"] as const)(
  "records an expired completion failure only after requester settlement (%s)",
  async (route) => {
    const { subagent } = records();
    const target = {
      agentId: "main",
      sessionKey: subagent.requesterSessionKey,
      sessionId: "failed-delivery-requester",
      storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
    };
    await upsertSessionEntryCore(target, {
      sessionId: target.sessionId,
      lifecycleRevision: "requester-revision",
      updatedAt: Date.now(),
    });
    Object.assign(subagent, {
      completionTarget: "parent",
      completionRequesterSessionId: target.sessionId,
      completionRequesterLifecycleRevision: "requester-revision",
      requesterStorePath: target.storePath,
      requesterSettleWake: { status: "pending", attemptCount: 0 },
    });
    if (route === "error-failed") {
      subagent.execution.outcome = {
        status: "error",
        error: "Descendant completion can no longer continue this yielded requester.",
      };
    }
    subagent.completion = { required: true, resultText: null, capturedAt: Date.now() };
    seedSubagentCompletionDelivery({ subagent });
    subagentRuns.set(subagent.runId, subagent);
    publishSubagentRunsAfterAtomicStore(subagentRuns, [subagent.runId])();
    expect(
      await blockSubagentCompletionDelivery({
        subagent,
        reason: "deadline reached",
        suspendedReason: "expiry",
      }),
    ).toBe(true);
    expect(await loadTranscriptEvents(target)).toEqual([]);
    await mutateRequesterCompletionBatch({
      entries: [subagent],
      assertCurrent: () => {},
      operation: {
        kind: "settle",
        outcome:
          route === "delivered"
            ? { delivered: true, path: "direct" }
            : { delivered: false, path: "none", error: "requester turn failed" },
      },
    });
    const notices = (await loadTranscriptEvents(target)).filter(
      (event) => isRecord(event) && event.type === "custom_message",
    );
    expect(notices).toHaveLength(route === "delivered" ? 0 : 1);
    expect(loadSubagentRegistryFromSqlite().get(subagent.runId)?.delivery?.disposition).toBe(
      route === "delivered" ? "delivered" : "permanent_failure",
    );
  },
);

it.each([false, true])(
  "settles an unreachable yielded task only after custody retires (%s)",
  async (retired) => {
    using warning = vi.spyOn(subagentRegistryLog, "warn").mockImplementation(() => {});
    const { subagent } = records();
    await upsertSessionEntryCore(
      {
        agentId: "main",
        sessionKey: subagent.requesterSessionKey,
        storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
      },
      {
        sessionId: "resumed-requester",
        updatedAt: Date.now(),
        lifecycleRunId: "resumed-requester-run",
        activeWriterRunId: "resumed-requester-run",
      },
    );
    markSubagentRunPausedAfterYield({ entry: subagent });
    subagentRuns.set(subagent.runId, subagent);
    if (retired) {
      subagentRuns.retireCompletionAuthority(subagent);
    }
    const complete = vi.fn<Parameters<typeof settleUnreachableYieldedSubagentRun>[0]["complete"]>(
      async () => {},
    );
    expect(
      await settleUnreachableYieldedSubagentRun({
        runId: subagent.runId,
        entry: subagent,
        complete,
      }),
    ).toBe(retired);
    if (retired) {
      expect(warning).toHaveBeenCalledWith("Settling unreachable yielded subagent", {
        runId: subagent.runId,
        requesterSessionKey: subagent.requesterSessionKey,
        reason: "Descendant completion can no longer continue this yielded requester.",
        yieldedAt: subagent.execution.endedAt,
      });
      expect(complete).toHaveBeenCalledWith(
        expect.objectContaining({
          endedAt: subagent.execution.endedAt,
          settleYielded: true,
          outcome: {
            status: "error",
            error: "Descendant completion can no longer continue this yielded requester.",
          },
        }),
        "sweeper-unreachable-yield",
      );
    } else {
      expect(warning).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
    }
  },
);

it("retains a restored running child until fresh requester admission can deliver its notice", async () => {
  using warning = vi.spyOn(subagentRegistryLog, "warn").mockImplementation(() => {});
  const startedBeforeThisProcess = Math.floor(performance.timeOrigin) - 60_000;
  const subagent = createSubagentRunRecord({
    runId: "restored-running-child",
    requesterAgentId: "main",
    createdAt: startedBeforeThisProcess,
    startedAt: startedBeforeThisProcess,
    expectsCompletionMessage: true,
  });
  publishCommittedRecords(subagent);
  await resetSubagentRegistryForTests({ persist: false });
  await closeOpenClawStateDatabaseAsync();
  await restoreSubagentRunsFromDisk({ runs: subagentRuns });
  const restored = expectDefined(subagentRuns.get(subagent.runId), "restored running child");
  expect(subagentRuns.isCompletionAuthorityRetired(restored)).toBe(true);

  await testing.sweepOnceForTests();

  const pending = loadSubagentRegistryFromSqlite().get(subagent.runId);
  expect(warning).not.toHaveBeenCalled();
  expect(pending?.execution.status).toBe("running");
  expect(pending?.delivery?.status).toBe("pending");
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let settleRootWork: ReturnType<typeof observeRootWork>;
vi.mock("../../../config/config.js", { spy: true });

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-child-store-replaced-"));
  await resetSubagentRegistryForTests({ persist: false });
  vi.mocked(getRuntimeConfig).mockReturnValue({});
  settleRootWork = observeRootWork();
  publishSystemEventStoreResolver(() => "original-store");
});

afterEach(async () => {
  await settleRootWork();
  await closeOpenClawStateDatabaseAsync();
  await resetSubagentRegistryForTests({ persist: false });
  publishSystemEventStoreResolver(undefined);
  resetHeartbeatEventsForTest();
  vi.mocked(getRuntimeConfig).mockReset();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
