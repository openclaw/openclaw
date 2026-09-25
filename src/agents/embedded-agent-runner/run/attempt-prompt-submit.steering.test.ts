// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useSubagentControlFixture } from "../../subagents/registry/subagent-control.test-support.js";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { reactivateCompletedSubagentSession } from "../../../gateway/session-subagent-reactivation.js";
import { emitAgentEvent } from "../../../infra/agent-events.js";
import { findTaskByRunId } from "../../../tasks/runtime-internal.js";
import { buildAgentRunTerminalReplySnapshot } from "../../agent-run-terminal-reply.js";
import {
  createAssistant,
  createAssistantResultStream,
  createAutoCompactionSettings,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { testing as deliveryTesting } from "../../subagents/announce/subagent-announce-delivery.test-support.js";
import { testing as announceTesting } from "../../subagents/announce/subagent-announce-output.test-support.js";
import { markPendingFinalDelivery } from "../../subagents/registry/subagent-registry-lifecycle-delivery.js";
import { subagentRuns } from "../../subagents/registry/subagent-registry-memory.js";
import { hasDescendantRunAwaitingSettle } from "../../subagents/registry/subagent-registry-read.js";
import { persistSubagentRunsToDiskOrThrow } from "../../subagents/registry/subagent-registry-state.js";
import {
  leasePendingAgentSteeringItems,
  markRequesterTurnYielded,
  prependAgentSteeringPrompt,
  registerSubagentRun,
  releasePendingAgentSteeringItems,
  settleRequesterAfterSessionSpawns,
} from "../../subagents/registry/subagent-registry.js";
import {
  settleSubagentRegistryPersistenceWork,
  writeSubagentSessionEntry,
} from "../../subagents/registry/subagent-registry.persistence.test-support.js";
import { createSessionsYieldTool } from "../../tools/sessions-yield-tool.js";
import {
  clearEmbeddedSessionPromptStates,
  getEmbeddedSessionPromptState,
} from "../session-prompt-state.js";
import { abortable } from "./abortable.js";
import {
  handleEmbeddedAttemptPromptError,
  submitEmbeddedAttemptPrompt,
} from "./attempt-prompt-submit.js";
import { SESSIONS_YIELD_ABORT_REASON } from "./attempt-sessions-yield.js";

const fixture = useSubagentControlFixture();
registerAgentSessionLoopTestLifecycle();

const sessionId = "steering-requester";
const requesterSessionKey = "agent:main:main";
const childSessionKey = "agent:main:subagent:kept-child";
const childRunId = "completed-child";
const nextRunId = "child-follow-up";
const answer = `${"<finding>".repeat(700)}complete answer tail`;
const escapedAnswer = `${"&lt;finding&gt;".repeat(700)}complete answer tail`;

afterEach(() => {
  announceTesting.setDepsForTest();
  deliveryTesting.setDepsForTest();
  clearEmbeddedSessionPromptStates([sessionId]);
});

async function prepareSteering() {
  const storePath = await writeSubagentSessionEntry({
    stateDir: fixture.stateDir,
    agentId: "main",
    sessionKey: childSessionKey,
    defaultSessionId: "kept-child-session",
  });
  await registerSubagentRun({
    runId: childRunId,
    childSessionKey,
    requesterSessionKey,
    requesterDisplayKey: "main",
    task: "Inspect the findings",
    cleanup: "keep",
    spawnMode: "session",
    expectsCompletionMessage: true,
  });
  const child = subagentRuns.get(childRunId);
  if (!child) {
    throw new Error("Expected registered child");
  }
  const terminalReply = buildAgentRunTerminalReplySnapshot({ visibleText: answer });
  if (terminalReply.disposition !== "visible") {
    throw new Error("Expected visible terminal reply");
  }
  expect(terminalReply.text).toHaveLength(4_096);
  child.execution = {
    ...child.execution,
    status: "terminal",
    endedAt: Date.now(),
    outcome: { status: "ok" },
    transcriptTarget: {
      agentId: "main",
      sessionId: "kept-child-session",
      sessionKey: childSessionKey,
      storePath,
    },
  };
  child.completion = { required: true, resultText: terminalReply.text, terminalReply };
  markPendingFinalDelivery({ entry: child });
  persistSubagentRunsToDiskOrThrow(subagentRuns, [childRunId]);
  announceTesting.setDepsForTest({
    findTranscriptEvent: async (_target, match) => {
      const event = {
        type: "message",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: answer }],
          __openclaw: { runId: childRunId },
        },
      };
      return match(event) ? { event } : undefined;
    },
  });
  const leaseId = "requester-steering";
  const leased = await leasePendingAgentSteeringItems({ requesterSessionKey, leaseId });
  if (!leased) {
    throw new Error("Expected queued child result");
  }
  expect(leased.isCurrent()).toBe(true);
  expect(leased.prompt).toContain(escapedAnswer);
  return { child, leasedSteering: { ...leased, leaseId } };
}

function submissionInput(
  leasedSteering: Awaited<ReturnType<typeof prepareSteering>>["leasedSteering"],
) {
  const sessionPromptState = getEmbeddedSessionPromptState(sessionId);
  const prompt = prependAgentSteeringPrompt({
    steeringPrompt: leasedSteering.prompt,
    prompt: "Use the findings to finish the answer.",
  });
  return {
    attempt: { sessionId, sessionKey: requesterSessionKey },
    contextTokenBudget: 32_000,
    images: [],
    leasedSteering,
    modelPrompt: prompt,
    transcriptPrompt: prompt,
    onFinalPromptText: vi.fn(),
    onSteeringAcknowledged: vi.fn(),
    persistToolResultProjections: vi.fn(async () => {}),
    runtimeOnly: false,
    sessionPromptState,
    systemPrompt: "Use the child findings.",
    toolResultAggregateMaxChars: 8_000,
    toolResultMaxChars: 4_000,
    toolResultPromptProjectionState: sessionPromptState.toolResults,
    trajectoryRecorder: null,
    transcriptLeafId: null,
  };
}

it("does not replay a consumed baseline or block the next child after requester yield", async () => {
  const requesterCalls: Array<{ message?: string; inputProvenance?: { sourceTool?: string } }> = [];
  deliveryTesting.setDepsForTest({
    callGateway: (async (request: { method: string; params?: (typeof requesterCalls)[number] }) => {
      if (request.method !== "agent") {
        throw new Error(`Unexpected delivery RPC ${request.method}`);
      }
      requesterCalls.push(request.params ?? {});
      return { result: { payloads: [{ text: "Continue from the new CI report." }] } };
    }) as typeof import("../../../gateway/call.js").callGateway,
    getRequesterSessionActivity: () => ({ sessionId, isActive: false }),
  });
  await writeSubagentSessionEntry({
    stateDir: fixture.stateDir,
    agentId: "main",
    sessionKey: requesterSessionKey,
    defaultSessionId: sessionId,
  });
  const { child, leasedSteering } = await prepareSteering();
  const requesterTurnRunId = "requester-awaiting-ci";
  const ci = {
    runId: "later-ci-report",
    childSessionKey: "agent:main:subagent:later-ci",
    expectsCompletionMessage: true,
  };
  registerSubagentRun({
    ...ci,
    requesterSessionKey,
    requesterDisplayKey: "main",
    requesterAgentId: "main",
    requesterTurnRunId,
    task: "Watch the next CI run",
    cleanup: "keep",
  });
  const controller = new AbortController();
  const yieldTool = createSessionsYieldTool({
    sessionId,
    claimYield: () =>
      markRequesterTurnYielded({
        requesterSessionKey,
        requesterAgentId: "main",
        requesterTurnRunId,
      }) > 0,
    onYield: () => {
      controller.abort(SESSIONS_YIELD_ABORT_REASON);
      session.agent.abort();
    },
  });
  const { session } = await createTestSession({ customTools: [yieldTool] });
  streamMocks.streamSimple.mockImplementation((model: Model, context: Context) => {
    expect(JSON.stringify(context.messages)).toContain(escapedAnswer);
    return createAssistantResultStream(
      createAssistant(
        model,
        [{ type: "toolCall", id: "wait-for-ci", name: "sessions_yield", arguments: {} }],
        "toolUse",
      ),
    );
  });
  const input = submissionInput(leasedSteering);
  let promptSettled: Promise<void> | undefined;
  const submission = submitEmbeddedAttemptPrompt({
    ...input,
    activeSession: session,
    promptActiveSession: (prompt, options) => {
      promptSettled = session.prompt(prompt, options);
      return abortable(controller.signal, promptSettled);
    },
  });
  await submission.catch(async (error: unknown) => {
    await handleEmbeddedAttemptPromptError({
      activeSession: session,
      attempt: { runId: requesterTurnRunId, sessionId },
      error,
      handleMidTurnPrecheckRequest: vi.fn(),
      markYieldAborted: vi.fn(),
      releaseLeasedSteering: () => releasePendingAgentSteeringItems(leasedSteering),
      withOwnedTranscriptWrite: async (operation) => operation(),
      yieldAbortSettled: promptSettled ?? null,
      yieldDetected: controller.signal.aborted,
      yieldMessage: null,
    });
  });
  await promptSettled;
  expect(controller.signal.reason).toBe(SESSIONS_YIELD_ABORT_REASON);
  expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
  expect(
    settleRequesterAfterSessionSpawns({
      requesterSessionKey,
      requesterAgentId: "main",
      requesterTurnRunId,
      requesterYielded: true,
      acceptedSessionSpawns: [ci],
    }),
  ).toBe(true);
  expect(subagentRuns.get(ci.runId)?.requesterSettleWake).toMatchObject({
    batchRunIds: [ci.runId],
    requesterYieldBatch: true,
  });
  expect(child.delivery?.status).toBe("delivered");
  expect(input.onSteeringAcknowledged).toHaveBeenCalledOnce();
  // Acknowledgment starts worker-backed cleanup; join that owner before reading settlement.
  await settleSubagentRegistryPersistenceWork();
  expect(hasDescendantRunAwaitingSettle(requesterSessionKey, ci.runId)).toBe(false);
  expect(
    await leasePendingAgentSteeringItems({ requesterSessionKey, leaseId: "next-requester-turn" }),
  ).toBeUndefined();

  // The later child completes through the lifecycle listener. Only its frozen
  // batch may resume the requester; the old result must not be replayed.
  emitAgentEvent({
    runId: ci.runId,
    sessionKey: ci.childSessionKey,
    stream: "lifecycle",
    data: {
      phase: "end",
      endedAt: Date.now(),
      terminalReply: { disposition: "visible", text: "New CI report." },
    },
  });
  await settleSubagentRegistryPersistenceWork();
  expect(subagentRuns.get(ci.runId)?.delivery?.status).toBe("delivered");
  expect(subagentRuns.get(ci.runId)?.requesterSettleWake).toBeUndefined();
  expect(requesterCalls).toHaveLength(1);
  expect(requesterCalls[0]?.inputProvenance?.sourceTool).toBe("subagent_settle");
  expect(requesterCalls[0]?.message).toContain("New CI report.");
  expect(requesterCalls[0]?.message).not.toContain("complete answer tail");
  expect(findTaskByRunId(ci.runId)?.deliveryStatus).toBe("delivered");
});

it.each(["preflight", "compaction", "failed-dispatch", "ordinary-abort"])(
  "does not acknowledge unconsumed or cancelled steering (%s)",
  async (phase) => {
    const { child, leasedSteering } = await prepareSteering();
    const { session } = await createTestSession();
    const input = submissionInput(leasedSteering);
    const originalTransformContext = session.agent.transformContext;
    const error = new Error("aborted", {
      cause: phase === "ordinary-abort" ? "cancelled" : SESSIONS_YIELD_ABORT_REASON,
    });
    const baseStreamFn = () => {
      if (phase === "failed-dispatch") {
        throw error;
      }
      return createAssistantResultStream(createAssistant(testModel, []));
    };
    session.agent.streamFn = baseStreamFn;
    await expect(
      submitEmbeddedAttemptPrompt({
        ...input,
        activeSession: session,
        promptActiveSession: async (_prompt, options) => {
          if (phase === "failed-dispatch" || phase === "ordinary-abort") {
            options?.preflightResult?.(true);
          }
          if (phase !== "preflight") {
            await session.agent.streamFn(testModel, { messages: [] });
          }
          throw error;
        },
      }),
    ).rejects.toBe(error);
    expect(input.onSteeringAcknowledged).not.toHaveBeenCalled();
    expect(child.delivery?.status).toBe("in_progress");
    expect(session.agent.streamFn).toBe(baseStreamFn);
    expect(session.agent.transformContext).toBe(originalTransformContext);
    releasePendingAgentSteeringItems(leasedSteering);
    expect(child.delivery?.status).toBe("pending");
  },
);

it.each([false, true])(
  "preserves parent continuation and cancellation after child reactivation (abort=%s)",
  async (abort) => {
    const { leasedSteering } = await prepareSteering();
    const requests: Context["messages"][] = [];
    const followUp = vi.fn(async () => {
      expect(requests).toHaveLength(1);
      expect(JSON.stringify(requests[0])).toContain(escapedAnswer);
      expect(leasedSteering.isCurrent()).toBe(true);
      expect(
        await reactivateCompletedSubagentSession({
          sessionKey: childSessionKey,
          runId: nextRunId,
          task: "Check the remaining finding.",
        }),
      ).toBe(true);
      expect(subagentRuns.has(childRunId)).toBe(false);
      expect(subagentRuns.get(nextRunId)?.execution.status).toBe("running");
      expect(leasedSteering.isCurrent()).toBe(false);
      return { content: [{ type: "text" as const, text: "Follow-up accepted." }], details: {} };
    });
    const { session } = await createTestSession({
      customTools: [
        {
          name: "follow_up",
          label: "Follow up",
          description: "Continue the completed child's work.",
          parameters: Type.Object({}),
          execute: followUp,
        },
      ],
    });
    streamMocks.streamSimple.mockImplementation((model: Model, context: Context) => {
      requests.push(structuredClone(context.messages));
      return createAssistantResultStream(
        createAssistant(
          model,
          requests.length === 1
            ? [{ type: "toolCall", id: "follow-up-call", name: "follow_up", arguments: {} }]
            : [{ type: "text", text: "Parent answer complete." }],
          requests.length === 1 ? "toolUse" : "stop",
        ),
      );
    });
    const input = submissionInput(leasedSteering);
    input.persistToolResultProjections.mockImplementation(async () => {
      if (abort && input.persistToolResultProjections.mock.calls.length === 2) {
        session.agent.abort();
      }
    });
    await submitEmbeddedAttemptPrompt({
      ...input,
      activeSession: session,
      promptActiveSession: (prompt, options) => session.prompt(prompt, options),
    });

    expect(followUp).toHaveBeenCalledOnce();
    expect(JSON.stringify(requests[0])).toContain(escapedAnswer);
    expect(subagentRuns.has(childRunId)).toBe(false);
    expect(subagentRuns.get(nextRunId)).toMatchObject({
      task: "Check the remaining finding.",
      execution: { status: "running" },
    });
    expect(leasedSteering.isCurrent()).toBe(false);
    expect(input.persistToolResultProjections).toHaveBeenCalledTimes(2);
    if (abort) {
      expect(session.messages.at(-1)).toMatchObject({
        role: "custom",
        customType: "openclaw:turn-aborted",
      });
      expect(requests).toHaveLength(1);
    } else {
      expect(session.messages.at(-1)).not.toHaveProperty("errorMessage");
      expect(session.messages.at(-1)).toMatchObject({
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "Parent answer complete." }],
      });
      expect(requests).toHaveLength(2);
      expect(JSON.stringify(requests[1])).toContain(escapedAnswer);
    }
    expect(input.onSteeringAcknowledged).toHaveBeenCalledOnce();
    expect(subagentRuns.get(nextRunId)?.delivery?.steeringLeaseId).toBeUndefined();
  },
);

it("rejects a changed completion source before first delivery and releases its lease", async () => {
  const { child, leasedSteering } = await prepareSteering();
  const { session } = await createTestSession();
  const input = submissionInput(leasedSteering);
  child.execution.outcome = { status: "error", error: "Completion invalidated." };
  expect(leasedSteering.isCurrent()).toBe(false);
  const releaseLeasedSteering = vi.fn((error?: unknown) => {
    releasePendingAgentSteeringItems({ ...leasedSteering, error: String(error) });
  });
  const failed = submitEmbeddedAttemptPrompt({
    ...input,
    activeSession: session,
    promptActiveSession: (prompt, options) => session.prompt(prompt, options),
  });
  const outcome = await failed.catch((error: unknown) =>
    handleEmbeddedAttemptPromptError({
      activeSession: session,
      attempt: { runId: "requester-turn", sessionId },
      error,
      handleMidTurnPrecheckRequest: vi.fn(),
      markYieldAborted: vi.fn(),
      releaseLeasedSteering,
      withOwnedTranscriptWrite: async (operation) => operation(),
      yieldAbortSettled: null,
      yieldDetected: false,
      yieldMessage: null,
    }),
  );

  expect(outcome).toMatchObject({
    promptFailure: {
      source: "prompt",
      error: expect.objectContaining({
        message: "The queued child results lost authority before requester prompt submission.",
      }),
    },
  });
  expect(streamMocks.streamSimple).not.toHaveBeenCalled();
  expect(releaseLeasedSteering).toHaveBeenCalledOnce();
  expect(input.onSteeringAcknowledged).not.toHaveBeenCalled();
  expect(child.delivery?.status).toBe("pending");
  expect(child.delivery?.steeringLeaseId).toBeUndefined();
});

it("keeps source validation until foreground delivery after pre-prompt compaction", async () => {
  const { child, leasedSteering } = await prepareSteering();
  const model = { ...testModel, contextWindow: 4_096, maxTokens: 512 };
  const sessionManager = SessionManager.inMemory();
  sessionManager.appendMessage({
    role: "user",
    content: "Earlier investigation details. ".repeat(650),
    timestamp: 1,
  });
  sessionManager.appendMessage(
    createAssistant(model, [{ type: "text", text: "Earlier result." }], "stop", 5_000),
  );
  sessionManager.appendMessage({
    role: "user",
    content: "Keep the latest observation.",
    timestamp: 3,
  });
  sessionManager.appendMessage(
    createAssistant(model, [{ type: "text", text: "Observation kept." }], "stop", 5_000),
  );
  const { session } = await createTestSession({
    model,
    sessionManager,
    settingsManager: createAutoCompactionSettings(),
  });
  const requests: Array<{ messages: Context["messages"]; compacting: boolean }> = [];
  streamMocks.streamSimple.mockImplementation((activeModel: Model, context: Context) => {
    requests.push({
      messages: structuredClone(context.messages),
      compacting: session.isCompacting,
    });
    child.execution.outcome = {
      status: "error",
      error: "Completion invalidated during compaction.",
    };
    return createAssistantResultStream(
      createAssistant(activeModel, [{ type: "text", text: "Earlier investigation summarized." }]),
    );
  });
  await submitEmbeddedAttemptPrompt({
    ...submissionInput(leasedSteering),
    activeSession: session,
    promptActiveSession: (prompt, options) => session.prompt(prompt, options),
  });

  expect(requests).toHaveLength(1);
  expect(requests[0]?.compacting).toBe(true);
  expect(session.messages.at(-1)).toMatchObject({
    role: "assistant",
    stopReason: "error",
    errorMessage: "The queued child results lost authority before requester prompt submission.",
  });
});
