// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useSubagentControlFixture } from "../../subagents/registry/subagent-control.test-support.js";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { reactivateCompletedSubagentSession } from "../../../gateway/session-subagent-reactivation.js";
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
import { testing as announceTesting } from "../../subagents/announce/subagent-announce-output.test-support.js";
import { markPendingFinalDelivery } from "../../subagents/registry/subagent-registry-lifecycle-delivery.js";
import { subagentRuns } from "../../subagents/registry/subagent-registry-memory.js";
import { persistSubagentRunsToDiskOrThrow } from "../../subagents/registry/subagent-registry-state.js";
import {
  leasePendingAgentSteeringItems,
  prependAgentSteeringPrompt,
  registerSubagentRun,
  releasePendingAgentSteeringItems,
} from "../../subagents/registry/subagent-registry.js";
import { writeSubagentSessionEntry } from "../../subagents/registry/subagent-registry.persistence.test-support.js";
import {
  clearEmbeddedSessionPromptStates,
  getEmbeddedSessionPromptState,
} from "../session-prompt-state.js";
import {
  handleEmbeddedAttemptPromptError,
  submitEmbeddedAttemptPrompt,
} from "./attempt-prompt-submit.js";

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
  clearEmbeddedSessionPromptStates([sessionId]);
});

async function prepareSteering() {
  const storePath = await writeSubagentSessionEntry({
    stateDir: fixture.stateDir,
    agentId: "main",
    sessionKey: childSessionKey,
    defaultSessionId: "kept-child-session",
  });
  registerSubagentRun({
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
