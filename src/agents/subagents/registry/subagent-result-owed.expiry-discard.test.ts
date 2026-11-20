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

it.each(["suspended", "pending", "not_required"] as const)(
  "reports expired %s delivery to an idle requester only when required",
  async (status) => {
    using warn = vi.spyOn(subagentRegistryLog, "warn").mockImplementation(() => {});
    const endedAt = Date.now();
    const required = status !== "not_required";
    const suspended = status === "suspended";
    const expiresAt = endedAt + (suspended ? 7 * 24 * 60 * 60_000 : 30 * 60_000);
    const resultText =
      "Captured before drain: the missing invoice is in archive A. " + "x".repeat(3_000);
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
      updatedAt: endedAt,
    });
    // Restore the durable drain-interrupted outcome; the requester never starts another turn.
    const entry = createSubagentStoreRunFixture({
      runId: "owed-expiry-child",
      requesterStorePath: target.storePath,
      expectsCompletionMessage: required,
      endedReason: "subagent-error",
      completionRequesterSessionId: target.sessionId,
      completionRequesterLifecycleRevision: "expiry-requester-revision",
      createdAt: endedAt - 60_000,
      execution: {
        status: "terminal",
        startedAt: endedAt - 60_000,
        endedAt,
        outcome: { status: "error", error: "Gateway stopped" },
      },
      completion: {
        required,
        capturedAt: endedAt,
        resultText,
        terminalReply: { disposition: "visible", text: resultText },
      },
      delivery: suspended
        ? { status: "suspended", suspendedAt: endedAt, suspendedReason: "expiry" }
        : { status },
    });
    await mutateSubagentRuns([entry.runId], () => ({
      value: undefined,
      postimages: new Map([[entry.runId, entry]]),
    }));
    expect(await loadTranscriptEvents(target)).toEqual([]);

    vi.setSystemTime(expiresAt - 1);
    await testing.sweepOnceForTests();
    expect(loadSubagentRegistryFromSqlite().get(entry.runId)?.delivery?.status).toBe(status);

    vi.setSystemTime(expiresAt);
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
    expect(notices).toHaveLength(required ? 1 : 0);
    if (!required) {
      expect(persisted?.delivery?.status).toBe("not_required");
      expect(warn).not.toHaveBeenCalled();
      return;
    }
    expect(persisted?.delivery).toMatchObject({ status: "discarded", discardReason: "expired" });
    expect(persisted?.completion?.resultText).toBe(resultText);
    expect(notices[0]).toMatchObject({
      content: expect.stringContaining(
        "Captured before drain: the missing invoice is in archive A.",
      ),
      details: expect.objectContaining({ childRunId: entry.runId, error: "expired" }),
    });
    const rendered = JSON.stringify(notices[0]);
    expect(rendered).toContain("Interrupted by Gateway restart; not resumed.");
    expect(rendered).toContain("[result truncated; see full-result recovery below]");
    expect(rendered).toContain("Full-result recovery:");
    expect(rendered).not.toContain(resultText);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("delivery discarded"),
      expect.objectContaining({ runId: entry.runId, reason: "expired" }),
    );
  },
);
