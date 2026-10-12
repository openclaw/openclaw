/** Full-entry coverage for sessions_yield terminal projection. */
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createSubagentRunRecord } from "../subagent-test-fixtures.test-helpers.js";
import type { SubagentRunRecord } from "../subagents/registry/subagent-registry.types.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  mockedGlobalHookRunner,
  mockedClassifyAssistantFailoverReason,
  mockedRunEmbeddedAttempt,
  mockedBuildEmbeddedRunPayloads,
  createOverflowRunParams,
  resetSharedRunIntegrationHarnessMocks,
  useOpenAIPlatformAuthFixture,
} from "./run.overflow-compaction.harness.js";
import { loadSharedRunIntegrationHarness } from "./run.shared-integration-harness.test-support.js";

let state: OpenClawTestState;
let runEmbeddedAgent: Awaited<ReturnType<typeof loadSharedRunIntegrationHarness>>;

describe("sessions_yield orchestration", () => {
  beforeAll(async () => {
    runEmbeddedAgent = await loadSharedRunIntegrationHarness();
  });

  beforeEach(async () => {
    resetSharedRunIntegrationHarnessMocks();
    const { createOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");
    state = await createOpenClawTestState({ label: "sessions-yield.orchestration" });
    mockedGlobalHookRunner.hasHooks.mockImplementation(() => false);
  });

  afterEach(async () => {
    await state?.cleanup();
  });

  it.each([
    { spawnOnRetry: false, agentHarnessId: "openclaw", outerCandidate: false },
    { spawnOnRetry: true, agentHarnessId: "codex", outerCandidate: false },
    { spawnOnRetry: true, agentHarnessId: "openclaw", outerCandidate: true },
  ])(
    "preserves child ownership through transient retries ($agentHarnessId, new child: $spawnOnRetry, candidate: $outerCandidate)",
    async ({ spawnOnRetry, agentHarnessId, outerCandidate }) => {
      const registry = await import("../subagents/registry/subagent-registry.js");
      const { settleRequesterTurnAfterSessionSpawns } =
        await import("../subagents/registry/subagent-registry-requester-yield.js");
      const { createReplyOperation } = await import("../../auto-reply/reply/reply-run-registry.js");
      const params = { ...createOverflowRunParams(state), runId: "yield-retry-parent" };
      const runs = new Map<string, SubagentRunRecord>();
      const persistOrThrow = vi.fn();
      const schedule = vi.fn();
      const { createRequesterInitialTransferFixture, markRequesterTurnYieldedWithAuthority } =
        await import("../subagents/registry/subagent-registry-requester-yield.test-support.js");
      const transfer = createRequesterInitialTransferFixture(runs, persistOrThrow);
      const markYield = vi
        .spyOn(registry, "markRequesterTurnYielded")
        .mockImplementation((claim) =>
          markRequesterTurnYieldedWithAuthority({ ...claim, runs, transfer }),
        );
      const settle = vi
        .spyOn(registry, "settleRequesterAfterSessionSpawns")
        .mockImplementation((claim) =>
          settleRequesterTurnAfterSessionSpawns({ ...claim, runs, transfer, schedule }),
        );
      const acceptChild = (runId: string) => {
        const child = createSubagentRunRecord({
          runId,
          childSessionKey: `agent:main:subagent:${runId}`,
          requesterSessionKey: params.sessionKey,
          requesterAgentId: params.agentId,
          requesterTurnRunId: params.runId,
          expectsCompletionMessage: true,
          execution: { status: "running", startedAt: Date.now() },
          completion: { required: true },
          delivery: { status: "pending" },
        });
        runs.set(runId, child);
        return { runId, childSessionKey: child.childSessionKey, expectsCompletionMessage: true };
      };
      const replyOperation = createReplyOperation({
        sessionKey: params.sessionKey,
        sessionId: params.sessionId,
        resetTriggered: false,
      });
      mockedClassifyAssistantFailoverReason.mockReturnValue("server_error");
      useOpenAIPlatformAuthFixture();
      mockedRunEmbeddedAttempt
        .mockImplementationOnce(async () => {
          const accepted = acceptChild("child-before-retry");
          expectDefined(runs.get(accepted.runId), "accepted child").execution = {
            status: "terminal",
            endedAt: Date.now(),
            outcome: { status: "ok" },
          };
          const assistant = makeAssistantMessageFixture({
            provider: "openai",
            api: "openai-responses",
            model: "gpt-5.6-luna",
            stopReason: "error",
            errorMessage: "Responses stream ended with unresolved tool calls",
            content: [],
          });
          return makeAttemptResult({
            agentHarnessId,
            terminal: { kind: "ok" },
            assistantTexts: [],
            currentAttemptAssistant: assistant,
            lastAssistant: assistant,
            acceptedSessionSpawns: [accepted],
          });
        })
        .mockImplementationOnce(async () => {
          const accepted = spawnOnRetry ? [acceptChild("child-after-retry")] : [];
          await markYield({
            requesterSessionKey: params.sessionKey,
            requesterAgentId: params.agentId,
            requesterTurnRunId: params.runId,
          });
          return makeAttemptResult({
            agentHarnessId,
            assistantTexts: [],
            yieldDetected: true,
            acceptedSessionSpawns: accepted,
          });
        });
      try {
        const result = await runEmbeddedAgent({
          ...params,
          provider: "openai",
          model: "gpt-5.6-luna",
          agentHarnessId,
          replyOperation,
          ...(outerCandidate ? { isFinalFallbackAttempt: false } : {}),
        });
        expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
        expect(result.meta.yielded).toBe(true);
        expect(result.requesterContinuationSettled).toBe(outerCandidate ? undefined : true);
        expect(result.acceptedSessionSpawns?.map((spawn) => spawn.runId).toSorted()).toEqual(
          [...runs.keys()].toSorted(),
        );
        for (const child of runs.values()) {
          if (outerCandidate) {
            expect(child).toMatchObject({
              requesterTurnRunId: params.runId,
              requesterTurnYielded: true,
            });
            expect(child.requesterSettleWake).toBeUndefined();
            expect(settle).not.toHaveBeenCalled();
            continue;
          }
          expect(child).toMatchObject({
            requesterTurnRunId: undefined,
            requesterTurnYielded: undefined,
            requesterSettleWake: {
              status: "pending",
              requesterYieldBatch: true,
              batchRunIds: [...runs.keys()].toSorted(),
            },
          });
        }
      } finally {
        replyOperation.complete();
        markYield.mockRestore();
        settle.mockRestore();
      }
    },
  );

  it("clientToolCalls takes precedence over yieldDetected", async () => {
    // Edge case: both flags set (shouldn't happen, but clientToolCalls wins)
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        yieldDetected: true,
        clientToolCalls: [{ name: "hosted_tool", params: { arg: "value" } }],
      }),
    );

    const result = await runEmbeddedAgent({
      ...createOverflowRunParams(state),
      runId: "run-yield-vs-client-tool",
    });

    // clientToolCalls wins — tool_calls stopReason, pendingToolCalls populated
    expect(result.meta.stopReason).toBe("tool_calls");
    expect(result.meta.pendingToolCalls).toHaveLength(1);
    const hostedToolCall = expectDefined(result.meta.pendingToolCalls![0], "hosted tool call");
    expect(hostedToolCall.name).toBe("hosted_tool");
    expect(result.payloads).toBeUndefined();
  });

  it("preserves order across multiple client tool calls in one attempt (#52288)", async () => {
    // Regression: a turn that invokes three client tools must surface all
    // three through `pendingToolCalls`, in the order the LLM emitted them.
    // Pre-fix this slot was a single variable that only kept the last call.
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        clientToolCalls: [
          { name: "create_graph", params: { nodes: ["a", "b"] } },
          { name: "activate_graph", params: {} },
          { name: "get_status", params: {} },
        ],
      }),
    );

    const result = await runEmbeddedAgent({
      ...createOverflowRunParams(state),
      runId: "run-multi-client-tool",
    });

    expect(result.meta.stopReason).toBe("tool_calls");
    expect(result.meta.pendingToolCalls).toHaveLength(3);
    expect(result.meta.pendingToolCalls!.map((c) => c.name)).toEqual([
      "create_graph",
      "activate_graph",
      "get_status",
    ]);
    const firstCall = expectDefined(result.meta.pendingToolCalls![0], "first pending tool call");
    expect(JSON.parse(firstCall.arguments)).toEqual({
      nodes: ["a", "b"],
    });
  });

  describe("yield with continuation evidence", () => {
    it.each(["accepted", "refused", "unregistered"] as const)(
      "uses the owner's message wait registration as continuation evidence (%s)",
      async (registration) => {
        const registry = await import("../subagents/registry/subagent-registry.test-helpers.js");
        const { createRequesterYieldCallback } =
          await import("../openclaw-tools.requester-yield.js");
        const { createSessionsYieldTool } = await import("../tools/sessions-yield-tool.js");
        const { buildEmbeddedRunPayloads } =
          await vi.importActual<typeof import("./run/payloads.js")>("./run/payloads.js");
        mockedBuildEmbeddedRunPayloads.mockImplementation(buildEmbeddedRunPayloads);
        const accepted = registration === "accepted";
        const finalText = "Continued after the rejected wait and completed the task.";
        const finalAssistant = makeAssistantMessageFixture({
          content: [{ type: "text", text: finalText }],
          stopReason: "stop",
        });
        const params = {
          ...createOverflowRunParams(state),
          sessionKey: "agent:main:subagent:message-wait",
          runId: "message-wait-run",
        };
        await registry.resetSubagentRegistryForTests({ persist: false });
        if (registration !== "unregistered") {
          await registry.addSubagentRunForTests(
            createSubagentRunRecord({
              runId: params.runId,
              childSessionKey: params.sessionKey,
              requesterSessionKey: "agent:main:parent",
              expectsCompletionMessage: true,
              execution: { status: "running" },
              completion: { required: true },
              delivery: { status: "pending" },
              suppressCompletionDelivery: registration === "refused",
            }),
          );
        }
        mockedRunEmbeddedAttempt.mockImplementationOnce(async () => {
          let yieldMessageWaitRegistered: boolean | undefined;
          const onYield = vi.fn(
            (_message: string, _acknowledgment?: string, registered?: boolean) => {
              yieldMessageWaitRegistered = registered;
            },
          );
          const tool = createSessionsYieldTool({
            sessionId: params.sessionId,
            claimYield: createRequesterYieldCallback({
              requesterSessionKey: params.sessionKey,
              requesterAgentId: params.agentId,
              requesterTurnRunId: params.runId,
            }),
            onYield,
          });
          const result = await tool.execute("yield-message", { waitFor: "message" });
          if (accepted) {
            expect(result.details).toEqual({ status: "yielded" });
            expect(onYield).toHaveBeenCalledExactlyOnceWith("Turn yielded.", undefined, true);
          } else {
            expect(result.details).toMatchObject({ status: "nothing_pending" });
            expect(onYield).not.toHaveBeenCalled();
            expect(yieldMessageWaitRegistered).toBeUndefined();
          }
          expect(
            registry.getSubagentRunByRunId(params.runId)?.requesterSettleWake?.pauseNotice,
          ).toEqual(
            registration === "accepted"
              ? { acknowledgment: "Paused awaiting continuation." }
              : undefined,
          );
          return makeAttemptResult({
            yieldDetected: onYield.mock.calls.length > 0,
            yieldMessageWaitRegistered,
            assistantTexts: accepted ? [] : [finalText],
            ...(!accepted
              ? { currentAttemptAssistant: finalAssistant, lastAssistant: finalAssistant }
              : {}),
          });
        });
        try {
          const result = await runEmbeddedAgent(params);
          if (accepted) {
            expect(result.meta.yielded).toBe(true);
            expect(result.meta.livenessState).toBe("paused");
            expect(result.payloads ?? []).toEqual([]);
          } else {
            expect(result.meta.yielded).toBeUndefined();
            expect(result.meta.livenessState).not.toBe("paused");
            expect(result.meta.continuationPending).toBeUndefined();
            expect(result.requesterContinuationSettled).toBeUndefined();
            expect(result.meta.finalAssistantVisibleText).toBe(finalText);
            expect(result.payloads).toEqual([expect.objectContaining({ text: finalText })]);
          }
        } finally {
          await registry.resetSubagentRegistryForTests({ persist: false });
        }
      },
    );

    it("rejects an unregistered accepted child instead of silently yielding", async () => {
      mockedRunEmbeddedAttempt.mockResolvedValueOnce(
        makeAttemptResult({
          yieldDetected: true,
          assistantTexts: [],
          acceptedSessionSpawns: [
            {
              runId: "missing-child-run",
              childSessionKey: "agent:main:subagent:missing",
              expectsCompletionMessage: true,
            },
          ],
        }),
      );
      await expect(
        runEmbeddedAgent({
          ...createOverflowRunParams(state),
          runId: "run-yield-missing-child",
        }),
      ).rejects.toThrow("accepted continuation children could not transfer terminal delivery");
    });

    it("yield with async started tool — diagnostic suppressed", async () => {
      mockedRunEmbeddedAttempt.mockResolvedValueOnce(
        makeAttemptResult({
          yieldDetected: true,
          assistantTexts: [],
          toolMetas: [{ toolName: "my_async_tool", asyncStarted: true }],
        }),
      );

      const result = await runEmbeddedAgent({
        ...createOverflowRunParams(state),
        runId: "run-yield-async-tool-suppressed",
      });

      // Async tool activity is continuation evidence → no diagnostic payload
      expect(result.payloads).toBeUndefined();
      expect(result.meta.stopReason).toBe("end_turn");
      expect(result.meta.yielded).toBe(true);
    });

    it("preserves runtime continuation when a non-announcing collector was also accepted", async () => {
      mockedRunEmbeddedAttempt.mockResolvedValueOnce(
        makeAttemptResult({
          yieldDetected: true,
          assistantTexts: [],
          runtimeContinuationStarted: true,
          acceptedSessionSpawns: [
            {
              runId: "collector-run",
              childSessionKey: "agent:main:subagent:collector",
              expectsCompletionMessage: false,
            },
          ],
        }),
      );

      const result = await runEmbeddedAgent({
        ...createOverflowRunParams(state),
        runId: "run-yield-runtime-continuation-suppressed",
      });

      expect(result.payloads).toBeUndefined();
      expect(result.meta.stopReason).toBe("end_turn");
      expect(result.meta.yielded).toBe(true);
      expect(result.meta.replayInvalid).toBe(true);
      expect(result.requesterContinuationSettled).toBeUndefined();
    });
  });

  it("emits diagnostic payload when yieldDetected has no continuation evidence", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        yieldDetected: true,
        assistantTexts: [],
      }),
    );

    const result = await runEmbeddedAgent({
      ...createOverflowRunParams(state),
      runId: "run-yield-no-continuation",
    });

    // yieldDetected without any continuation source → diagnostic payload
    expect(result.payloads).toHaveLength(1);
    const diagnosticPayload = expectDefined(result.payloads![0], "diagnostic payload");
    expect(diagnosticPayload.text).toBe(
      "⚠️ Turn yielded without a continuation source. Send a message to resume.",
    );
    // stopReason is still end_turn (yield semantics preserved)
    expect(result.meta.stopReason).toBe("end_turn");
    // No pending tool calls
    expect(result.meta.pendingToolCalls).toBeUndefined();
  });
});
