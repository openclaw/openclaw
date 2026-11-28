import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import { getAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import { SUBAGENT_ENDED_REASON_ERROR } from "./subagent-lifecycle-events.js";
import { subagentRegistryLog } from "./subagent-registry-lifecycle-log.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { markSubagentRunPausedAfterYield } from "./subagent-registry-run-pause.js";
import { settleRestartInterruptedSubagentRun } from "./subagent-registry-sweep-settle.js";
import { resetSubagentRegistryForTests } from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const SUBAGENT_RESTART_INTERRUPTED_ERROR =
  "The Gateway restarted without confirming this subagent's result. Remote work may still be running or may have finished. Check the original worker and its saved work before retrying.";
const PROCESS_STARTED_AT = 1_800_000_000_000;
const NOW = PROCESS_STARTED_AT + 60_000;

function restoredRunningRow(overrides: Partial<SubagentRunRecord> = {}) {
  const entry = createSubagentRunRecord({
    runId: "restart-interrupted-run",
    requesterOrigin: { channel: "telegram", to: "chat:requester", accountId: "primary" },
    createdAt: PROCESS_STARTED_AT - 10 * 60_000,
    startedAt: PROCESS_STARTED_AT - 10 * 60_000,
    expectsCompletionMessage: true,
    ...overrides,
  });
  subagentRuns.set(entry.runId, entry);
  return entry;
}

function settle(entry: SubagentRunRecord) {
  const complete = vi.fn<Parameters<typeof settleRestartInterruptedSubagentRun>[0]["complete"]>(
    async () => {},
  );
  return {
    complete,
    settled: settleRestartInterruptedSubagentRun({
      runId: entry.runId,
      entry,
      complete,
      now: NOW,
      processStartedAt: PROCESS_STARTED_AT,
    }),
  };
}

beforeEach(async () => {
  await resetSubagentRegistryForTests({ persist: false });
});

afterEach(async () => {
  await resetSubagentRegistryForTests({ persist: false });
  vi.restoreAllMocks();
});

it("fails a running child restored from an earlier Gateway so its requester wakes", () =>
  withOpenClawTestState({ label: "child-restart-no-final" }, async () => {
    setRuntimeConfigSnapshot({});
    using warning = vi.spyOn(subagentRegistryLog, "warn").mockImplementation(() => {});
    const entry = restoredRunningRow();
    // Startup has admitted fresh completion custody; the child's outcome is unknown.

    const { complete, settled } = settle(entry);

    expect(await settled).toBe(true);
    expect(warning).toHaveBeenCalledWith("Settling subagent interrupted by Gateway restart", {
      runId: entry.runId,
      requesterSessionKey: entry.requesterSessionKey,
      createdAt: entry.createdAt,
    });
    expect(complete).toHaveBeenCalledWith(
      {
        runId: entry.runId,
        expectedEntry: entry,
        recoveryCurrent: undefined,
        endedAt: NOW,
        outcome: { status: "error", error: SUBAGENT_RESTART_INTERRUPTED_ERROR },
        terminalReply: { disposition: "empty" },
        reason: SUBAGENT_ENDED_REASON_ERROR,
        sendFarewell: true,
        accountId: "primary",
        triggerCleanup: true,
      },
      "sweeper-restart-interrupted",
    );
  }));

it("recovers only the stopped run's saved answer, even after a later turn", () =>
  withOpenClawTestState({ label: "child-restart-saved-final" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionId: "reused-child",
      sessionKey: "agent:main:subagent:child",
      storePath: state.statePath("transcript.sqlite"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: NOW });
    const manager = await SessionManager.openAsync(scope);
    const finalAt = PROCESS_STARTED_AT - 1;
    for (const [runId, text, stopReason, runTerminal] of [
      ["interrupted", "partial answer", "aborted", true],
      ["checkpoint", "Stopped: one repair remains.", "stop", undefined],
      ["completed", "saved child answer", "stop", true],
      ["later", "another run's answer", "stop", true],
    ] as const) {
      const message = {
        ...makeAgentAssistantMessage({
          content: [{ type: "text", text }],
          stopReason,
          timestamp: finalAt,
        }),
        __openclaw: { runId, runTerminal },
      };
      await manager.appendMessageAsync(message);
    }
    for (const runId of ["completed", "interrupted", "checkpoint"]) {
      const entry = restoredRunningRow({
        runId,
        execution: { status: "running", transcriptTarget: scope },
      });
      const { complete, settled } = settle(entry);
      expect(await settled).toBe(true);
      expect(complete.mock.calls[0]?.[0]).toMatchObject(
        runId === "completed"
          ? {
              endedAt: finalAt,
              outcome: { status: "ok" },
              terminalReply: { disposition: "visible", text: "saved child answer" },
            }
          : {
              outcome: { status: "error", error: SUBAGENT_RESTART_INTERRUPTED_ERROR },
              terminalReply: { disposition: "empty" },
            },
      );
    }
  }));

it.each([
  [
    "a current-lifecycle row with an earlier wall-clock timestamp",
    (entry: SubagentRunRecord) => {
      entry.execution.lifecycleGeneration = getAgentEventLifecycleGeneration();
    },
  ],
  [
    "a row awaiting fresh completion admission",
    (entry: SubagentRunRecord) => subagentRuns.retireCompletionAuthority(entry),
  ],
  [
    "a row this process created",
    (entry: SubagentRunRecord) => {
      entry.createdAt = PROCESS_STARTED_AT + 1;
    },
  ],
  [
    "an ended row",
    (entry: SubagentRunRecord) => {
      entry.execution = {
        status: "terminal",
        startedAt: entry.execution.startedAt,
        endedAt: NOW - 1,
        outcome: { status: "ok" },
      };
    },
  ],
  [
    "a yielded row",
    (entry: SubagentRunRecord) => {
      markSubagentRunPausedAfterYield({ entry });
      subagentRuns.retireCompletionAuthority(entry);
    },
  ],
] as const)("leaves %s to its existing owner", async (_name, prepare) => {
  using warning = vi.spyOn(subagentRegistryLog, "warn").mockImplementation(() => {});
  const entry = restoredRunningRow();
  prepare(entry);

  const { complete, settled } = settle(entry);

  expect(await settled).toBe(false);
  expect(complete).not.toHaveBeenCalled();
  expect(warning).not.toHaveBeenCalled();
});
