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
import { renderRuntimeCoordinationFailureCopy } from "../../failover/assistant-request-failure-copy.js";
import { subagentRegistryLog } from "./subagent-registry-lifecycle-log.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import {
  createSubagentStoreRunFixture,
  loadSubagentRegistryFromSqlite,
} from "./subagent-registry-state.fixture.test-support.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";
import { resetSubagentRegistryForTests, testing } from "./subagent-registry.test-helpers.js";

vi.mock("../../../config/config.js", { spy: true });

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let settleRootWork: (keepObserving?: boolean) => Promise<void>;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-01T00:00:00Z"));
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-result-owed-expiry-"));
  await resetSubagentRegistryForTests({ persist: false });
  vi.mocked(getRuntimeConfig).mockReturnValue({});
  settleRootWork = observeRootWork();
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

it("records a visible failure notice when a suspended required result expires", async () => {
  // Silence the operator warning; the requester-visible notice is the contract here.
  using _ = vi.spyOn(subagentRegistryLog, "warn").mockImplementation(() => {});
  const suspendedAt = Date.now();
  const resultText = "Expiry case: the finished child found the missing invoice.";
  const target = {
    agentId: "main",
    sessionKey: "agent:main:main",
    sessionId: "expiry-requester",
    storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
  };
  publishSystemEventStoreResolver(() => target.storePath);
  await upsertSessionEntryCore(target, {
    sessionId: target.sessionId,
    lifecycleRevision: "expiry-requester-revision",
    updatedAt: suspendedAt,
  });
  // Start at the durable state produced after a completion window exhausts.
  // No cancellation, requester deletion, store change, or revocation occurs.
  const entry = createSubagentStoreRunFixture({
    runId: "owed-expiry-child",
    requesterStorePath: target.storePath,
    completionTarget: "parent",
    completionRequesterSessionId: target.sessionId,
    completionRequesterLifecycleRevision: "expiry-requester-revision",
    createdAt: suspendedAt - 31 * 60_000,
    execution: {
      status: "terminal",
      startedAt: suspendedAt - 31 * 60_000,
      endedAt: suspendedAt - 30 * 60_000,
      outcome: { status: "ok" },
    },
    completion: {
      required: true,
      capturedAt: suspendedAt - 30 * 60_000,
      resultText,
      terminalReply: { disposition: "visible", text: resultText },
    },
    delivery: {
      status: "suspended",
      suspendedAt,
      suspendedReason: "expiry",
      lastError: "requester delivery unavailable during completion window",
    },
  });
  await mutateSubagentRuns([entry.runId], () => ({
    value: undefined,
    postimages: new Map([[entry.runId, entry]]),
  }));
  expect(await loadTranscriptEvents(target)).toEqual([]);

  vi.setSystemTime(suspendedAt + 7 * 24 * 60 * 60_000 - 1);
  await testing.sweepOnceForTests();
  expect(loadSubagentRegistryFromSqlite().get(entry.runId)?.delivery?.status).toBe("suspended");

  vi.setSystemTime(suspendedAt + 7 * 24 * 60 * 60_000);
  await testing.sweepOnceForTests();
  await settleRootWork(true);

  const persisted = loadSubagentRegistryFromSqlite().get(entry.runId);
  const notices = (await loadTranscriptEvents(target)).filter((event) => {
    const message = event as {
      type?: string;
      display?: boolean;
      details?: { childRunId?: string };
    };
    return (
      message.type === "custom_message" &&
      message.display === true &&
      message.details?.childRunId === entry.runId
    );
  });
  // Retiring the obligation must not be silent: the requester gets exactly one notice.
  expect(persisted?.delivery?.status).toBe("discarded");
  expect(notices).toHaveLength(1);
  expect(JSON.stringify(notices[0])).toContain(
    JSON.stringify(renderRuntimeCoordinationFailureCopy("child_completion_delivery_failed")).slice(
      1,
      -1,
    ),
  );
});
