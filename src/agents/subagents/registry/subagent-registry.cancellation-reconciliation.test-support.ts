import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  waitForFast,
  type SubagentRegistryHarness,
} from "../../subagent-test-fixtures.test-helpers.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_KILLED,
} from "./subagent-lifecycle-events.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { updateSubagentRunFixture as updateFixtureRun } from "./subagent-registry-result-refresh.test-support.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";
import type { createSubagentRegistryMockState } from "./subagent-registry.mock-state.test-support.js";
import { makeKilledRun } from "./subagent-registry.run-fixtures.test-support.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { resolveSubagentSessionStatus } from "./subagent-session-metrics.js";

export function registerCancellationReconciliationTests({
  getRegistry,
  mocks,
  findRequesterRun,
  mockEndedHooks,
}: {
  getRegistry: () => Pick<
    SubagentRegistryHarness,
    "addSubagentRunForTests" | "markSubagentRunTerminated" | "testing"
  >;
  mocks: Pick<
    ReturnType<typeof createSubagentRegistryMockState>,
    | "entries"
    | "callGateway"
    | "persistRegistryRows"
    | "captureSubagentCompletionReply"
    | "runSubagentAnnounceFlow"
    | "getAgentRunContext"
    | "runSubagentEnded"
    | "onSubagentEnded"
    | "removeInternalSessionEffectsSession"
    | "emitSessionLifecycleEvent"
  >;
  findRequesterRun: (runId: string) => SubagentRunRecord | undefined;
  mockEndedHooks: () => void;
}): void {
  it.each(["late completion", "earlier deadline"] as const)(
    "reconciles stable operator cancellation against %s",
    async (source) => {
      const mod = getRegistry();
      const now = Date.now();
      const startedAt = now - 10_000;
      const killedAt = now - 1_000;
      const runId = "run-stable-cancellation";
      const childSessionKey = "agent:main:subagent:stable-cancellation";
      const earlierDeadline = source === "earlier deadline";
      mocks.entries = {
        [childSessionKey]: {
          ...(earlierDeadline ? {} : { lifecycleRevision: "revision-stable-cancellation" }),
          sessionId: "sess-stable-cancellation",
          updatedAt: now,
          status: earlierDeadline ? "killed" : "done",
          startedAt,
          endedAt: now,
        },
      };
      await mod.addSubagentRunForTests(
        makeKilledRun(killedAt, {
          runId,
          childSessionKey,
          childSessionIdentity: {
            sessionId: "sess-stable-cancellation",
            ...(earlierDeadline ? {} : { lifecycleRevision: "revision-stable-cancellation" }),
          },
          task: "preserve authoritative cancellation outcome",
          killReconciliation: { killedAt, taskCancellationAccepted: true },
          expectsCompletionMessage: !earlierDeadline,
          createdAt: startedAt,
          startedAt,
          ...(earlierDeadline ? { runTimeoutSeconds: 8 } : { cleanup: "delete", archiveAtMs: now }),
        }),
      );
      vi.setSystemTime(killedAt + 5 * 60_000);
      await mod.testing.sweepOnceForTests();
      await waitForFast(() => {
        const run = findRequesterRun(runId);
        if (earlierDeadline) {
          const timeoutAt = now - 2_000;
          expect(run).toMatchObject({
            endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
            execution: {
              status: "terminal",
              endedAt: timeoutAt,
              outcome: { status: "timeout", startedAt, endedAt: timeoutAt },
            },
          });
          expect(run?.execution.outcome?.error).toBeUndefined();
        } else {
          expect(run).toBeUndefined();
          expect(mocks.callGateway).toHaveBeenCalledWith({
            method: "sessions.delete",
            params: {
              key: childSessionKey,
              agentId: "main",
              deleteTranscript: true,
              emitLifecycleHooks: false,
              expectedLifecycleRevision: "revision-stable-cancellation",
              expectedSessionId: "sess-stable-cancellation",
            },
            timeoutMs: 10_000,
            assertDispatchCurrent: expect.any(Function),
            prepareDispatchCurrent: expect.any(Function),
          });
        }
      });
      if (!earlierDeadline) {
        expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
      }
    },
  );

  it("suppresses registry delivery when cancellation becomes durable during capture", async () => {
    const mod = getRegistry();
    const now = Date.now();
    const killedAt = now - 5 * 60_000;
    const startedAt = killedAt - 10_000;
    const completedAt = killedAt + 1_000;
    const runId = "run-cancelled-during-sweep-capture";
    const childSessionKey = "agent:main:subagent:cancelled-during-sweep-capture";
    const retirementWrites: string[][] = [];
    const publishedRows: SubagentRunRecord[] = [];
    mocks.persistRegistryRows.mockImplementation((runs, ids) => {
      const next = runs.get(runId);
      if (next) {
        publishedRows.push(structuredClone(next));
      } else if (ids.includes(runId)) {
        retirementWrites.push([...ids]);
      }
    });
    mocks.entries = {
      [childSessionKey]: {
        sessionId: "sess-cancelled-during-sweep-capture",
        updatedAt: completedAt,
        status: "done",
        startedAt,
        endedAt: completedAt,
      },
    };
    const captureEntered = createDeferred();
    const finishCapture = createDeferred<string>();
    mocks.captureSubagentCompletionReply.mockImplementationOnce(() => {
      captureEntered.resolve();
      return finishCapture.promise;
    });
    await mod.addSubagentRunForTests(
      makeKilledRun(killedAt, {
        runId,
        childSessionKey,
        childSessionIdentity: { sessionId: "sess-cancelled-during-sweep-capture" },
        task: "cancel during result capture",
        expectsCompletionMessage: false,
        createdAt: startedAt,
        startedAt,
      }),
    );

    expect(subagentRuns.has(runId)).toBe(true);
    const settleRootWork = observeRootWork();
    try {
      const sweep = mod.testing.sweepOnceForTests();
      await captureEntered.promise;
      await updateFixtureRun(runId, (next) => {
        expectDefined(
          next.killReconciliation,
          "cancelled run reconciliation",
        ).taskCancellationAccepted = true;
      });
      finishCapture.resolve("late provider result");
      await sweep;
    } finally {
      finishCapture.resolve("late provider result");
      // Sweep completion hands retirement to detached requester-settle work.
      await settleRootWork();
    }

    const terminal = expectDefined(publishedRows.at(-1), "last committed cancellation");
    expect(terminal).toMatchObject({
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      execution: {
        status: "terminal",
        endedAt: killedAt,
        outcome: { status: "error", error: "manual kill" },
      },
    });
    expect(terminal.completion?.resultText).toBeUndefined();
    expect(retirementWrites).toEqual([[runId]]);
    expect(subagentRuns.has(runId)).toBe(false);
    expect(findRequesterRun(runId)).toBeUndefined();
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
  });

  it("uses the kill time when reconciling a yielded run", async () => {
    const mod = getRegistry();
    const startedAt = Date.parse("2026-03-24T11:50:00Z");
    const yieldedAt = Date.parse("2026-03-24T11:59:00Z");
    const completedAt = Date.parse("2026-03-24T11:59:30Z");
    const killedAt = Date.parse("2026-03-24T12:00:00Z");
    const runId = "run-yielded-before-kill";
    const childSessionKey = "agent:main:subagent:yielded-before-kill";
    mocks.entries = {
      [childSessionKey]: {
        sessionId: "sess-yielded-before-kill",
        updatedAt: completedAt,
        status: "done",
        startedAt,
        endedAt: completedAt,
      },
    };
    await mod.addSubagentRunForTests({
      runId,
      childSessionKey,
      childSessionIdentity: { sessionId: "sess-yielded-before-kill" },
      task: "complete between yield and kill",
      expectsCompletionMessage: false,
      createdAt: startedAt,
      startedAt,
      endedAt: yieldedAt,
      pauseReason: "sessions_yield",
      cleanupHandled: false,
    });

    vi.setSystemTime(killedAt);
    expect(await mod.markSubagentRunTerminated({ runId, reason: "manual kill" })).toBe(1);
    const killedRun = findRequesterRun(runId);
    expect(killedRun).toMatchObject({
      execution: { status: "terminal", endedAt: yieldedAt },
      cleanupCompletedAt: killedAt,
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
    });

    vi.setSystemTime(killedAt + 5 * 60_000);
    await mod.testing.sweepOnceForTests();

    await waitForFast(() => {
      const run = findRequesterRun(runId);
      expect(run).toMatchObject({
        endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
        execution: {
          status: "terminal",
          endedAt: completedAt,
          outcome: { status: "ok", startedAt, endedAt: completedAt },
        },
      });
    });
  });

  it("retires a reconciled tombstone without replaying requester stop delivery", async () => {
    const mod = getRegistry();
    const killedAt = Date.now() - 5 * 60_000;
    const startedAt = killedAt - 60_000;
    const runId = "run-retired-kill";
    const childSessionKey = "agent:main:subagent:requester-stop-suppressed";
    await mod.addSubagentRunForTests(
      makeKilledRun(killedAt, {
        runId,
        childSessionKey,
        childSessionIdentity: { sessionId: "sess-requester-stop-suppressed" },
        task: "do not replay cancellation",
        expectsCompletionMessage: true,
        createdAt: startedAt,
        killReconciliation: { killedAt, suppressTaskDelivery: true },
      }),
    );
    await mod.testing.sweepOnceForTests();
    await waitForFast(() => expect(findRequesterRun(runId)).toBeUndefined());
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
  });

  it.each(["new completion", "new completion without start", "old completion"] as const)(
    "retires superseded tombstones without mutating the successor: %s",
    async (source) => {
      const mod = getRegistry();
      const oldStartedAt = Date.parse("2026-03-24T11:50:00Z");
      const killedAt = Date.parse("2026-03-24T11:55:00Z");
      const newStartedAt = Date.parse("2026-03-24T11:58:00Z");
      const endedAt = Date.parse(
        source === "old completion" ? "2026-03-24T11:56:00Z" : "2026-03-24T11:59:00Z",
      );
      const childSessionKey = "agent:main:subagent:reused";
      const runId = "run-old-tombstone";
      const newRunId = "run-new-generation";
      const withoutStart = source === "new completion without start";
      mocks.entries = {
        [childSessionKey]: {
          sessionId: "sess-reused",
          updatedAt: endedAt,
          status: "done",
          endedAt,
          ...(withoutStart
            ? {}
            : { startedAt: source === "old completion" ? oldStartedAt : newStartedAt }),
        },
      };
      const originalEntry = structuredClone(mocks.entries[childSessionKey]);
      if (!withoutStart) {
        mocks.getAgentRunContext.mockImplementation((id: string) =>
          id === newRunId ? ({} as never) : undefined,
        );
        mockEndedHooks();
      }
      let attachmentsRootDir: string | undefined;
      let attachmentsDir: string | undefined;
      const transcriptTarget = {
        agentId: "main",
        sessionId: "internal-run-old-tombstone",
        sessionKey: "agent:main:internal-session-effects:run-old-tombstone",
        storePath: "/tmp/test-store",
      };
      if (source === "new completion") {
        attachmentsRootDir = await fs.mkdtemp(
          path.join(os.tmpdir(), "openclaw-old-tombstone-attachments-"),
        );
        attachmentsDir = path.join(attachmentsRootDir, "child");
        await fs.mkdir(attachmentsDir, { recursive: true });
        await fs.writeFile(path.join(attachmentsDir, "artifact.txt"), "artifact");
      }
      await mod.addSubagentRunForTests(
        makeKilledRun(killedAt, {
          runId,
          childSessionKey,
          childSessionIdentity: { sessionId: "sess-reused" },
          task: "old generation",
          createdAt: oldStartedAt,
          startedAt: oldStartedAt,
          ...(withoutStart
            ? { runTimeoutSeconds: 60 }
            : { cleanup: "delete", sessionStartedAt: oldStartedAt }),
          ...(source === "new completion"
            ? {
                archiveAtMs: Date.now(),
                retainAttachmentsOnKeep: true,
                attachmentsDir,
                attachmentsRootDir,
                execution: {
                  status: "terminal",
                  startedAt: oldStartedAt,
                  endedAt: killedAt,
                  transcriptTarget,
                },
              }
            : {}),
        }),
      );
      await mod.addSubagentRunForTests({
        runId: newRunId,
        childSessionKey,
        childSessionIdentity: { sessionId: "sess-reused" },
        task: "new generation",
        createdAt: newStartedAt,
        startedAt: newStartedAt,
        ...(withoutStart ? { generation: 2 } : { sessionStartedAt: newStartedAt }),
      });
      await mod.testing.sweepOnceForTests();
      expect(findRequesterRun(runId)).toBeUndefined();
      if (withoutStart) {
        expect(resolveSubagentSessionStatus(subagentRuns.get(runId))).not.toBe("timeout");
        return;
      }
      const newRun = findRequesterRun(newRunId);
      expect(newRun).toBeDefined();
      expect(newRun?.execution.endedAt).toBeUndefined();
      expect(newRun?.execution.outcome).toBeUndefined();
      expect(mocks.runSubagentEnded).not.toHaveBeenCalled();
      expect(
        mocks.onSubagentEnded.mock.calls.some(
          ([params]) => params.childSessionKey === childSessionKey,
        ),
      ).toBe(false);
      expect(
        mocks.callGateway.mock.calls.some(([request]) => request.method === "sessions.delete"),
      ).toBe(false);
      if (source === "new completion") {
        expect(mocks.removeInternalSessionEffectsSession).toHaveBeenCalledWith(transcriptTarget);
        await expect(
          fs.access(expectDefined(attachmentsDir, "retained attachments")),
        ).resolves.toBeUndefined();
      } else {
        expect(mocks.entries[childSessionKey]).toEqual(originalEntry);
        expect(
          mocks.emitSessionLifecycleEvent.mock.calls.some(
            ([event]) => (event as { sessionKey?: string }).sessionKey === childSessionKey,
          ),
        ).toBe(false);
      }
    },
  );
}
