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
import {
  createSubagentStoreRunFixture,
  loadSubagentRegistryFromSqlite,
} from "./subagent-registry-state.fixture.test-support.js";
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

it.each([
  "direct",
  "restored-captured",
  "batch",
  "batch-retry",
  "yielded-batch",
  "legacy-yielded-batch",
  "expiry-delivered",
  "expiry-failed",
  "expiry-error-failed",
  "replaced-session",
  "replaced-revision",
] as const)(
  "records a required failed completion in its current requester transcript (%s)",
  async (route) => {
    using warning = vi.spyOn(subagentRegistryLog, "warn").mockImplementation(() => {});
    const expiry = route.startsWith("expiry-");
    const { subagent } = records();
    const target = {
      agentId: "main",
      sessionKey: subagent.requesterSessionKey,
      sessionId: "failed-delivery-requester",
      storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
    };
    await upsertSessionEntryCore(target, {
      sessionId: route === "replaced-session" ? "replacement-requester" : target.sessionId,
      lifecycleRevision:
        route === "replaced-revision" ? "replacement-revision" : "requester-revision",
      updatedAt: Date.now(),
    });
    Object.assign(subagent, {
      completionTarget: "parent",
      completionRequesterSessionId: target.sessionId,
      completionRequesterLifecycleRevision: "requester-revision",
      requesterStorePath: target.storePath,
      requesterSettleWake: { status: "pending", attemptCount: 0 },
    });
    if ((!expiry && route !== "restored-captured") || route === "expiry-error-failed") {
      subagent.execution.outcome = {
        status: "error",
        error: "Descendant completion can no longer continue this yielded requester.",
      };
    }
    subagent.completion = {
      required: true,
      resultText: route === "restored-captured" ? "captured child answer" : null,
      capturedAt: Date.now(),
    };
    if (route === "restored-captured") {
      subagent.delivery = { status: "pending", generation: 1 };
    }
    const batch = [subagent];
    if (route.endsWith("yielded-batch")) {
      subagent.requesterSettleWake = {
        status: "pending",
        attemptCount: 0,
        requesterYieldBatch: true,
        requesterRunId: "yielded-requester",
        batchRunIds: [subagent.runId, "second-child"],
      };
      if (route.includes("legacy-yielded-batch")) {
        delete subagent.requesterSettleWake.requesterRunId;
        delete subagent.requesterSettleWake.batchRunIds;
      }
    }
    if (route.endsWith("yielded-batch") || route === "batch-retry") {
      batch.push({
        ...structuredClone(subagent),
        runId: "second-child",
        taskRunId: "second-task",
        childSessionKey: "agent:main:subagent:second-child",
      });
    }
    for (const sibling of batch.slice(1)) {
      publishCommittedRecords(sibling);
    }
    publishCommittedRecords(subagent);
    if (!expiry && route !== "restored-captured") {
      subagentRuns.retireCompletionAuthority(subagent);
    }
    if (route === "restored-captured") {
      await resetSubagentRegistryForTests({ persist: false });
      await closeOpenClawStateDatabaseAsync();
      publishSystemEventStoreResolver(() => target.storePath);
      await restoreSubagentRunsFromDisk({ runs: subagentRuns });
      await testing.sweepOnceForTests();
      expect(loadSubagentRegistryFromSqlite().get(subagent.runId)?.completion?.resultText).toBe(
        "captured child answer",
      );
      expect(loadSubagentRegistryFromSqlite().get(subagent.runId)?.delivery?.status).toBe(
        "pending",
      );
      expect(warning).not.toHaveBeenCalled();
      expect(await loadTranscriptEvents(target)).toEqual([]);
      return;
    } else if (route !== "batch" && route !== "batch-retry" && !route.endsWith("yielded-batch")) {
      expect(
        await blockSubagentCompletionDelivery({
          subagent,
          reason: expiry ? "deadline reached" : "requester unavailable",
          suspendedReason: expiry ? "expiry" : "permanent_failure",
        }),
      ).toBe(true);
    } else {
      let committed: Parameters<typeof mutateRequesterCompletionBatch>[0]["committed"];
      const settle = () =>
        mutateRequesterCompletionBatch({
          entries: batch,
          assertCurrent: () => {},
          committed,
          onCommitted: (write) => {
            committed = write;
          },
          operation: {
            kind: "settle",
            outcome: {
              delivered: false,
              path: "none",
              disposition: "permanent_failure",
              error: "requester unavailable",
            },
          },
        });
      await settle();
      if (route === "batch-retry") {
        await settle();
      }
    }
    const events = await loadTranscriptEvents({
      ...target,
      sessionId: route === "replaced-session" ? "replacement-requester" : target.sessionId,
    });
    if (!expiry) {
      expect(warning).toHaveBeenCalledWith("Subagent completion delivery failed", {
        runId: subagent.runId,
        requesterSessionKey: subagent.requesterSessionKey,
        reason: "requester unavailable",
      });
    }
    const notices = events.filter((event) => isRecord(event) && event.type === "custom_message");
    // The notice goes to the requester chat as it is now, also after a reset or replacement.
    expect(notices).toEqual(
      expiry
        ? []
        : [
            expect.objectContaining({
              type: "custom_message",
              customType: "run-failed-before-reply",
              display: true,
              content: expect.stringContaining("child result couldn't be delivered"),
            }),
          ],
    );
    if (expiry) {
      await mutateRequesterCompletionBatch({
        entries: [subagent],
        assertCurrent: () => {},
        operation: {
          kind: "settle",
          outcome:
            route === "expiry-delivered"
              ? { delivered: true, path: "direct" }
              : { delivered: false, path: "none", error: "requester turn failed" },
        },
      });
      const settledNotices = (await loadTranscriptEvents(target)).filter(
        (event) => isRecord(event) && event.type === "custom_message",
      );
      expect(settledNotices).toHaveLength(route === "expiry-delivered" ? 0 : 1);
    }
    expect(loadSubagentRegistryFromSqlite().get(subagent.runId)?.delivery?.disposition).toBe(
      route === "expiry-delivered" ? "delivered" : "permanent_failure",
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

it("keeps pending completions with their requester when the store selector is republished", async () => {
  const { subagent } = records();
  subagent.requesterStorePath = "original-store";
  subagent.delivery = { status: "pending" };
  publishCommittedRecords(subagent);
  const yielded = createSubagentStoreRunFixture({
    runId: "yielded-child",
    childSessionKey: "agent:main:subagent:yielded-child",
    requesterStorePath: "original-store",
  });
  markSubagentRunPausedAfterYield({ entry: yielded });
  publishCommittedRecords(yielded);

  publishSystemEventStoreResolver(() => "replacement-store");
  await settleRootWork(true);

  // Delivery addresses the requester by key when it fires, not by its old store path.
  for (const entry of [subagent, yielded]) {
    expect(subagentRuns.isCompletionAuthorityRetired(entry)).toBe(false);
    expect(loadSubagentRegistryFromSqlite().get(entry.runId)?.delivery?.status).toBe("pending");
  }
});
