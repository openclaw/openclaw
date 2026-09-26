import { beforeEach, describe, expect, it } from "vitest";
import {
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../../../infra/agent-events.js";
import {
  clearAgentRunContext,
  registerAgentRunContext,
} from "../../../infra/agent-run-registry.js";
import { beginSessionWorkAdmission } from "../../../sessions/session-lifecycle-admission.js";
import { restartRecoveryTestHarness } from "./subagent-registry-restart-recovery.test-support.js";

const { mocks, childSessionKey, gatewayRuntime, dispatchAgent, run, recover } =
  restartRecoveryTestHarness;

describe("subagent registry restart recovery", () => {
  beforeEach(() => restartRecoveryTestHarness.reset());

  it("preserves an abort marker owned by a newer visible execution", async () => {
    mocks.entries[childSessionKey]!.lifecycleRunId = "newer-visible-run";

    expect(await recover(run())).toMatchObject({
      status: "terminal",
      suppressSessionEffects: true,
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
    expect(mocks.patchSessionEntryCore).not.toHaveBeenCalled();
    expect(mocks.entries[childSessionKey]).toMatchObject({
      lifecycleRunId: "newer-visible-run",
      abortedLastRun: true,
    });
  });

  describe("orphaned running sessions", () => {
    it.each([60_000, 3 * 24 * 60 * 60_000])(
      "reconciles a hard-kill orphan last observed %i ms ago",
      async (ageMs) => {
        const entry = run();
        const updatedAt = Date.now() - ageMs;
        entry.execution.lifecycleGeneration = getAgentEventLifecycleGeneration();
        Object.assign(mocks.entries[childSessionKey]!, {
          status: "running",
          lifecycleRunId: entry.runId,
          abortedLastRun: false,
          updatedAt,
        });
        rotateAgentEventLifecycleGeneration();

        expect(await recover(entry)).toMatchObject({
          status: "terminal",
          error: expect.stringContaining("Gateway restart"),
        });
        expect(mocks.entries[childSessionKey]?.updatedAt).toBe(updatedAt);
        expect(dispatchAgent).not.toHaveBeenCalled();
        expect(gatewayRuntime.sendRecoveryNotice).not.toHaveBeenCalled();
      },
    );

    it.each([
      "current lifecycle",
      "different run",
      "completed session",
      "completed session with stale abort marker",
    ])("does not invent a restart interruption for a %s", async (scenario) => {
      const entry = run();
      entry.execution.lifecycleGeneration = getAgentEventLifecycleGeneration();
      if (scenario !== "current lifecycle") {
        rotateAgentEventLifecycleGeneration();
      }
      Object.assign(mocks.entries[childSessionKey]!, {
        status: scenario.startsWith("completed session") ? "done" : "running",
        lifecycleRunId: scenario === "different run" ? "newer-run" : entry.runId,
        abortedLastRun: scenario === "completed session with stale abort marker",
      });
      expect(await recover(entry)).toEqual({ status: "ignored" });
      expect(dispatchAgent).not.toHaveBeenCalled();
      expect(mocks.patchSessionEntryCore).not.toHaveBeenCalled();
    });

    it.each([
      ["run", false],
      ["admission", false],
      ["run", true],
      ["admission", true],
    ] as const)(
      "does not mark a hard-kill orphan after a fresh %s owns its session (recovered=%s)",
      async (owner, recovered) => {
        const entry = run();
        if (recovered) {
          entry.taskRunId = "original-task-run";
          entry.execution.transcriptTarget = { sessionKey: "agent:main:internal:recovered" };
        }
        entry.execution.lifecycleGeneration = getAgentEventLifecycleGeneration();
        rotateAgentEventLifecycleGeneration();
        Object.assign(mocks.entries[childSessionKey]!, {
          status: "running",
          lifecycleRunId: recovered ? "steered-source" : entry.runId,
          abortedLastRun: false,
          subagentRecovery: recovered
            ? { lastRunId: entry.runId, sessionLifecycleRunId: "steered-source" }
            : undefined,
        });
        const lease =
          owner === "admission"
            ? await beginSessionWorkAdmission({
                scope: "/tmp/subagent-recovery.sqlite",
                identities: [childSessionKey, "session-id"],
                assertAllowed: () => {},
              })
            : undefined;
        if (owner === "run") {
          registerAgentRunContext("fresh-owner", {
            sessionKey: childSessionKey,
            sessionId: "session-id",
          });
        }
        try {
          expect(await recover(entry)).toEqual({ status: "deferred" });
          expect(mocks.entries[childSessionKey]?.abortedLastRun).toBe(false);
          expect(dispatchAgent).not.toHaveBeenCalled();
        } finally {
          lease?.release();
          clearAgentRunContext("fresh-owner");
        }
      },
    );

    it.each([
      "current lifecycle",
      "different task",
      "different recovery",
      "newer visible run",
      "missing transcript",
    ])("does not adopt a hidden recovery with %s", async (scenario) => {
      const entry = run({ taskRunId: "original-task-run" });
      entry.execution.lifecycleGeneration = getAgentEventLifecycleGeneration();
      entry.execution.transcriptTarget = { sessionKey: "agent:main:internal:recovered" };
      if (scenario !== "current lifecycle") {
        rotateAgentEventLifecycleGeneration();
      }
      Object.assign(mocks.entries[childSessionKey]!, {
        status: "running",
        lifecycleRunId: scenario === "newer visible run" ? "visible-run" : "original-task-run",
        abortedLastRun: false,
        subagentRecovery: {
          lastRunId: scenario === "different recovery" ? "older-recovery" : entry.runId,
          ...(scenario !== "different task" ? { sessionLifecycleRunId: "original-task-run" } : {}),
        },
      });
      if (scenario === "different task") {
        entry.taskRunId = "different-task-run";
      }
      if (scenario === "missing transcript") {
        entry.execution.transcriptTarget = undefined;
      }
      expect(await recover(entry)).toEqual({ status: "ignored" });
      expect(dispatchAgent).not.toHaveBeenCalled();
      expect(mocks.patchSessionEntryCore).not.toHaveBeenCalled();
    });

    it.each(["session", "visible turn"])(
      "keeps a replacement %s untouched when orphan marking waits for the store",
      async (replacementKind) => {
        const entry = run();
        if (replacementKind === "visible turn") {
          entry.taskRunId = "original-task-run";
          entry.execution.transcriptTarget = { sessionKey: "agent:main:internal:recovered" };
        }
        entry.execution.lifecycleGeneration = getAgentEventLifecycleGeneration();
        rotateAgentEventLifecycleGeneration();
        Object.assign(mocks.entries[childSessionKey]!, {
          status: "running",
          lifecycleRunId: replacementKind === "visible turn" ? "steered-source" : entry.runId,
          abortedLastRun: false,
          subagentRecovery: {
            lastRunId: entry.runId,
            sessionLifecycleRunId:
              replacementKind === "visible turn" ? "steered-source" : entry.runId,
          },
        });
        const replacementSessionId =
          replacementKind === "session" ? "replacement-session" : "session-id";
        mocks.patchSessionEntryCore.mockImplementationOnce(async (_scope, update) => {
          const replacement = {
            ...mocks.entries[childSessionKey]!,
            sessionId: replacementSessionId,
            lifecycleRunId: "replacement-run",
          };
          mocks.entries[childSessionKey] = replacement;
          return update({ ...replacement });
        });
        expect(await recover(entry)).toEqual({ status: "deferred" });
        expect(dispatchAgent).not.toHaveBeenCalled();
        expect(mocks.entries[childSessionKey]).toMatchObject({
          sessionId: replacementSessionId,
          lifecycleRunId: "replacement-run",
          abortedLastRun: false,
        });
      },
    );
  });

  it.each(["attempted", "consumed", "accepted", "abandoned"] as const)(
    "settles a persisted %s launch receipt without dispatch",
    async (phase) => {
      const entry = run();
      entry.execution.restartRecovery = {
        phase,
        sessionId: "session-id",
        sessionMarker: "session-id:1",
        idempotencyKey: "old-recovery-run",
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
      };
      rotateAgentEventLifecycleGeneration();
      expect(await recover(entry)).toMatchObject({
        status: "terminal",
        suppressSessionEffects: true,
      });
      expect(dispatchAgent).not.toHaveBeenCalled();
      expect(mocks.entries[childSessionKey]?.abortedLastRun).toBe(true);
    },
  );

  it.each(["sessions_yield", "steer-restart", "terminal", "queued", "non-aborted"])(
    "leaves %s ownership unchanged",
    async (owner) => {
      const entry = run();
      if (owner === "sessions_yield") {
        entry.pauseReason = "sessions_yield";
      }
      if (owner === "steer-restart") {
        entry.suppressAnnounceReason = "steer-restart";
      }
      if (owner === "terminal") {
        entry.execution = { status: "terminal", endedAt: Date.now(), outcome: { status: "ok" } };
      }
      if (owner === "queued") {
        entry.execution.status = "queued";
      }
      if (owner === "non-aborted") {
        mocks.entries[childSessionKey]!.abortedLastRun = false;
      }
      expect(await recover(entry)).toEqual({ status: "ignored" });
      expect(dispatchAgent).not.toHaveBeenCalled();
    },
  );
});
