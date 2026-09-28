import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { AgentEventPayload } from "../../../infra/agent-events.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import {
  createSessionEntry,
  createSubagentRunRecord,
  expectRecordFields,
  mockGatewayMethods,
  waitForFast,
  type SubagentRegistryHarness,
} from "../../subagent-test-fixtures.test-helpers.js";
import { SUBAGENT_ENDED_REASON_ERROR } from "./subagent-lifecycle-events.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";
import type { createSubagentRegistryMockState } from "./subagent-registry.mock-state.test-support.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function registerRestoredRunDeadlineSettlementTests({
  getRegistry,
  mocks,
  hydrateAndActivateRegistry,
}: {
  getRegistry: () => SubagentRegistryHarness;
  mocks: Pick<
    ReturnType<typeof createSubagentRegistryMockState>,
    | "resolveAgentTimeoutMs"
    | "restoreSubagentRunsFromDisk"
    | "callGateway"
    | "runSubagentAnnounceFlow"
  >;
  hydrateAndActivateRegistry: () => void;
}): void {
  const findRequesterRun = (runId: string) =>
    getRegistry()
      .listSubagentRunsForRequester("agent:main:main")
      .find((entry) => entry.runId === runId);
  it.each([
    {
      name: "prefers explicit run timeout over late restored agent.wait success",
      runId: "run-resumed-late-success",
      task: "resume after explicit timeout",
      waitStartedAfterMs: 0,
      waitEndedAfterMs: 61_000,
      expected: { status: "timeout", startedAfterMs: 0, endedAfterMs: 60_000, elapsedMs: 60_000 },
      label: "late restored wait success timeout outcome",
    },
    {
      name: "uses observed agent.wait start time when applying explicit run deadline",
      runId: "run-resumed-observed-start",
      task: "respect observed start",
      waitStartedAfterMs: 10_000,
      waitEndedAfterMs: 65_000,
      expected: { status: "ok", startedAfterMs: 10_000, endedAfterMs: 65_000, elapsedMs: 55_000 },
      label: "observed start success outcome",
    },
  ] as const)(
    "$name",
    async ({ runId, task, waitStartedAfterMs, waitEndedAfterMs, expected, label }) => {
      const createdAt = Date.parse("2026-03-24T11:59:00Z");
      vi.setSystemTime(createdAt + waitEndedAfterMs);
      mocks.resolveAgentTimeoutMs.mockReturnValue(60_000);
      mocks.restoreSubagentRunsFromDisk.mockImplementation(((params: {
        runs: Map<string, unknown>;
        mergeOnly?: boolean;
      }) => {
        params.runs.set(
          runId,
          createSubagentRunRecord({
            runId,
            task,
            runTimeoutSeconds: 60,
            createdAt,
            startedAt: createdAt,
            sessionStartedAt: createdAt,
          }),
        );
        return 1;
      }) as never);
      mockGatewayMethods(mocks.callGateway, {
        "agent.wait": {
          status: "ok",
          startedAt: createdAt + waitStartedAfterMs,
          endedAt: createdAt + waitEndedAfterMs,
        },
      });

      const settleRootWork = observeRootWork();
      try {
        hydrateAndActivateRegistry();

        await waitForFast(() => {
          const completedRun = findRequesterRun(runId);
          expect(completedRun?.execution.endedAt).toBe(createdAt + expected.endedAfterMs);
          expectRecordFields(
            completedRun?.execution.outcome,
            {
              status: expected.status,
              startedAt: createdAt + expected.startedAfterMs,
              endedAt: createdAt + expected.endedAfterMs,
              elapsedMs: expected.elapsedMs,
            },
            label,
          );
        });
      } finally {
        await settleRootWork();
      }
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    },
  );
}

export function registerRestartDrainCompletionSettlementTest({
  getRegistry,
  mocks,
  findRequesterRun,
}: {
  getRegistry: () => SubagentRegistryHarness;
  mocks: Pick<ReturnType<typeof createSubagentRegistryMockState>, "runSubagentAnnounceFlow">;
  findRequesterRun: (runId: string) => SubagentRunRecord | undefined;
}): void {
  it("retries a terminal completion deferred by restart drain", async () => {
    const mod = getRegistry();
    const now = Date.now();
    const runId = "run-terminal-restart-retry";
    mod.addSubagentRunForTests({
      runId,
      childSessionKey: "agent:main:subagent:terminal-restart-retry",
      task: "deliver terminal completion after restart",
      expectsCompletionMessage: true,
      createdAt: now - 10_000,
      startedAt: now - 9_000,
      endedAt: now - 1_000,
      endedReason: SUBAGENT_ENDED_REASON_ERROR,
      outcome: { status: "error", error: "provider interrupted" },
    });

    markGatewayRestartDraining();
    await expect(
      mod.finalizeInterruptedSubagentRun({
        runId,
        error: "provider interrupted",
        endedAt: now - 1_000,
      }),
    ).resolves.toBe(1);
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();

    resetGatewayWorkAdmission();
    const settleRootWork = observeRootWork();
    try {
      await vi.advanceTimersByTimeAsync(1_000);
    } finally {
      await settleRootWork();
    }
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledOnce();
    const entry = findRequesterRun(runId);
    expect(entry?.cleanupCompletedAt).toBeTypeOf("number");
  });
}

export function registerForcedCollectorCompletionSettlementTests({
  getRegistry,
  mocks,
  findRequesterRun,
  getLifecycleHandler,
  mockPendingAgentWait,
}: {
  getRegistry: () => SubagentRegistryHarness;
  mocks: Pick<
    ReturnType<typeof createSubagentRegistryMockState>,
    "callGateway" | "entries" | "runSubagentAnnounceFlow"
  >;
  findRequesterRun: (runId: string) => SubagentRunRecord | undefined;
  getLifecycleHandler: () => (event: Pick<AgentEventPayload, "runId" | "stream" | "data">) => void;
  mockPendingAgentWait: () => void;
}): void {
  it.each([
    { observation: "lifecycle", schema: false, captured: false },
    { observation: "wait", schema: false, captured: false },
    { observation: "lifecycle", schema: true, captured: false },
    { observation: "wait", schema: true, captured: false },
    { observation: "lifecycle", schema: true, captured: true },
    { observation: "wait", schema: true, captured: true },
  ])(
    "settles forced collector yield through $observation (schema=$schema, captured=$captured)",
    async ({ observation, schema, captured }) => {
      const mod = getRegistry();
      const runId = "forced-collector-yield";
      const childSessionKey = "agent:main:subagent:forced-collector-yield";
      const terminal = {
        status: "ok",
        startedAt: 111,
        endedAt: 222,
        yielded: true,
        livenessState: "paused",
      };
      const waitResult = createDeferred<Record<string, unknown>>();
      if (observation === "wait") {
        mocks.callGateway.mockImplementation(async () => waitResult.promise);
      } else {
        mockPendingAgentWait();
      }
      mocks.entries = {
        [childSessionKey]: createSessionEntry({ lifecycleRevision: "forced-yield" }),
      };
      const settleRootWork = observeRootWork();
      try {
        await mod.registerSubagentRun({
          runId,
          childSessionKey,
          task: "force the terminal boundary",
          collect: true,
          expectsCompletionMessage: false,
          swarmRequesterSessionKey: "agent:main:main",
          ...(schema ? { outputSchema: { type: "object" } } : {}),
        });
        if (captured) {
          mod.recordSwarmStructuredOutput(
            { runId, childSessionKey },
            { invalidAttempts: 0, structured: { answer: 42 } },
          );
        }
        if (observation === "wait") {
          waitResult.resolve(terminal);
        } else {
          getLifecycleHandler()({
            runId,
            stream: "lifecycle",
            data: { phase: "end", ...terminal },
          });
        }
        await vi.advanceTimersByTimeAsync(0);
      } finally {
        await settleRootWork();
      }
      const entry = findRequesterRun(runId);
      expect(entry?.execution.status).toBe("terminal");
      expect(entry?.collectorCompletion?.status).toBe(schema && !captured ? "failed" : "done");
      expect(entry?.pauseReason).toBeUndefined();
      if (captured) {
        expect(entry?.collectorCompletion?.structured).toEqual({ answer: 42 });
      } else if (schema) {
        expect(entry?.collectorCompletion?.schemaError).toBe("structured_output was not called");
      }
      expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
    },
  );
}
