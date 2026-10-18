import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createSubagentRunRecord } from "../subagent-test-fixtures.test-helpers.js";
import type { SubagentRunRecord } from "../subagents/registry/subagent-registry.types.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import type { SessionsYieldCallback } from "../tools/sessions-yield-tool.js";
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

function requester(params: ReturnType<typeof createOverflowRunParams>) {
  return {
    requesterSessionKey: params.sessionKey,
    requesterAgentId: params.agentId,
    requesterTurnRunId: params.runId,
  };
}

function spawn(runId: string, expectsCompletionMessage = true) {
  return { runId, childSessionKey: `agent:main:subagent:${runId}`, expectsCompletionMessage };
}

async function runAttempt(runId: string, attempt: Parameters<typeof makeAttemptResult>[0]) {
  mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult(attempt));
  return runEmbeddedAgent({ ...createOverflowRunParams(state), runId });
}

describe("sessions_yield orchestration", () => {
  beforeAll(async () => {
    runEmbeddedAgent = await loadSharedRunIntegrationHarness();
  });

  beforeEach(async () => {
    resetSharedRunIntegrationHarnessMocks();
    const { createOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");
    state = await createOpenClawTestState({ label: "sessions-yield.orchestration" });
    const { setRuntimeConfigSnapshot } = await import("../../config/runtime-snapshot.js");
    setRuntimeConfigSnapshot({});
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
      const { createReplyOperation } = await import("../../sessions/session-controller.js");
      const params = { ...createOverflowRunParams(state), runId: "yield-retry-parent" };
      const runs = new Map<string, SubagentRunRecord>();
      const schedule = vi.fn();
      const { createRequesterInitialTransferFixture, markRequesterTurnYieldedWithAuthority } =
        await import("../subagents/registry/subagent-registry-requester-yield.test-support.js");
      const transfer = createRequesterInitialTransferFixture(runs, vi.fn());
      const attempt = (overrides: Parameters<typeof makeAttemptResult>[0]) =>
        makeAttemptResult({ agentHarnessId, assistantTexts: [], ...overrides });
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
        const accepted = spawn(runId);
        const child = createSubagentRunRecord({
          ...accepted,
          ...requester(params),
          execution: { status: "running", startedAt: Date.now() },
        });
        runs.set(runId, child);
        return accepted;
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
            model: "gpt-5.6-luna",
            errorMessage: "Responses stream ended with unresolved tool calls",
            content: [],
          });
          return attempt({
            terminal: { kind: "ok" },
            currentAttemptAssistant: assistant,
            lastAssistant: assistant,
            acceptedSessionSpawns: [accepted],
          });
        })
        .mockImplementationOnce(async () => {
          const accepted = spawnOnRetry ? [acceptChild("child-after-retry")] : [];
          await markYield(requester(params));
          return attempt({
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
        expect(result).toMatchObject({
          meta: { yielded: true },
          requesterContinuationSettled: outerCandidate ? undefined : true,
        });
        expect(result.acceptedSessionSpawns?.map((child) => child.runId).toSorted()).toEqual(
          [...runs.keys()].toSorted(),
        );
        if (outerCandidate) {
          expect(settle).not.toHaveBeenCalled();
        }
        for (const child of runs.values()) {
          expect(child).toMatchObject({
            requesterTurnRunId: outerCandidate ? params.runId : undefined,
            requesterTurnYielded: outerCandidate ? true : undefined,
            requesterSettleWake: outerCandidate
              ? undefined
              : {
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

  it.each([true, false])(
    "preserves ordered client tool calls over yield=%s (#52288)",
    async (yieldDetected) => {
      const clientToolCalls = yieldDetected
        ? [{ name: "hosted_tool", params: { arg: "value" } }]
        : [
            { name: "create_graph", params: { nodes: ["a", "b"] } },
            { name: "activate_graph", params: {} },
            { name: "get_status", params: {} },
          ];
      const result = await runAttempt("client-tools", { yieldDetected, clientToolCalls });
      expect(result.meta.stopReason).toBe("tool_calls");
      expect(result.meta.pendingToolCalls?.map((c) => c.name)).toEqual(
        yieldDetected ? ["hosted_tool"] : ["create_graph", "activate_graph", "get_status"],
      );
      const firstCall = expectDefined(result.meta.pendingToolCalls![0], "first pending tool call");
      expect(JSON.parse(firstCall.arguments)).toEqual(
        yieldDetected ? { arg: "value" } : { nodes: ["a", "b"] },
      );
      expect(result.payloads).toBeUndefined();
    },
  );

  it.each(["accepted", "refused", "unregistered"] as const)(
    "uses the owner's message wait registration as continuation evidence (%s)",
    async (registration) => {
      const registry = await import("../subagents/registry/subagent-registry.test-helpers.js");
      const { createRequesterYieldCallback } = await import("../openclaw-tools.requester-yield.js");
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
            suppressCompletionDelivery: registration === "refused",
          }),
        );
      }
      mockedRunEmbeddedAttempt.mockImplementationOnce(async () => {
        const onYield = vi.fn<SessionsYieldCallback>();
        const tool = createSessionsYieldTool({
          sessionId: params.sessionId,
          claimYield: createRequesterYieldCallback(requester(params)),
          onYield,
        });
        const result = await tool.execute("yield-message", { waitFor: "message" });
        const yieldMessageWaitRegistered = onYield.mock.calls[0]?.[2];
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
        ).toEqual(accepted ? { acknowledgment: "Paused awaiting continuation." } : undefined);
        return makeAttemptResult({
          yieldDetected: onYield.mock.calls.length > 0,
          yieldMessageWaitRegistered,
          assistantTexts: accepted ? [] : [finalText],
          currentAttemptAssistant: accepted ? undefined : finalAssistant,
          lastAssistant: accepted ? undefined : finalAssistant,
        });
      });
      try {
        const result = await runEmbeddedAgent(params);
        if (accepted) {
          expect(result.meta).toMatchObject({ yielded: true, livenessState: "paused" });
          expect(result.payloads ?? []).toEqual([]);
        } else {
          expect(result.meta.livenessState).not.toBe("paused");
          expect(result).toMatchObject({
            meta: {
              yielded: undefined,
              continuationPending: undefined,
              finalAssistantVisibleText: finalText,
            },
            requesterContinuationSettled: undefined,
            payloads: [expect.objectContaining({ text: finalText })],
          });
        }
      } finally {
        await registry.resetSubagentRegistryForTests({ persist: false });
      }
    },
  );

  it("rejects an unregistered accepted child instead of silently yielding", async () => {
    await expect(
      runAttempt("run-yield-missing-child", {
        yieldDetected: true,
        assistantTexts: [],
        acceptedSessionSpawns: [spawn("missing-child-run")],
      }),
    ).rejects.toThrow("accepted continuation children could not transfer terminal delivery");
  });

  it.each(["async-tool", "runtime-continuation", "none"])(
    "handles yield continuation: %s",
    async (source) => {
      const continuation =
        source === "async-tool"
          ? { toolMetas: [{ toolName: "my_async_tool", asyncStarted: true }] }
          : source === "runtime-continuation"
            ? {
                runtimeContinuationStarted: true,
                acceptedSessionSpawns: [spawn("collector-run", false)],
              }
            : {};
      const result = await runAttempt(`run-yield-${source}-suppressed`, {
        yieldDetected: true,
        assistantTexts: [],
        ...continuation,
      });
      expect(result.meta.stopReason).toBe("end_turn");
      if (source === "none") {
        expect(result.payloads).toEqual([
          expect.objectContaining({
            text: "⚠️ Turn yielded without a continuation source. Send a message to resume.",
          }),
        ]);
        expect(result.meta.pendingToolCalls).toBeUndefined();
      } else {
        expect(result.payloads).toBeUndefined();
        expect(result.meta.yielded).toBe(true);
      }
      if (source === "runtime-continuation") {
        expect(result).toMatchObject({
          meta: { replayInvalid: true },
          requesterContinuationSettled: undefined,
        });
      }
    },
  );
});
