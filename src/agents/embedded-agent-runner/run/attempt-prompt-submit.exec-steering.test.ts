/**
 * Production-path proof for exec-completion steering.
 *
 * These cases drive the real prompt-submission path with a stubbed provider so
 * the guarantees hold at provider dispatch, not only in the queue helpers: a
 * completion reaches the provider request only for its owning agent, and an
 * occurrence acknowledged elsewhere is refused before any provider I/O.
 */
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { afterEach, expect, it, vi } from "vitest";
import {
  enqueueSystemEventEntry,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../../../infra/system-events.js";
import {
  enqueueExecSteeringCompletion,
  invalidateExecSteeringByOccurrence,
  leasePendingExecSteeringItems,
  prependExecSteeringPrompt,
  resetExecSteeringQueueForTest,
} from "../../exec-steering-queue.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { getEmbeddedSessionPromptState } from "../session-prompt-state.js";
import { submitEmbeddedAttemptPrompt } from "./attempt-prompt-submit.js";

registerAgentSessionLoopTestLifecycle();

const sessionId = "exec-steering-requester";
const requesterSessionKey = "global";
const leaseId = "run-research:exec-steering";

afterEach(() => {
  resetExecSteeringQueueForTest();
  resetSystemEventsForTest();
});

function recordProviderRequests(requests: Context["messages"][]): void {
  streamMocks.streamSimple.mockImplementation((model: Model, context: Context) => {
    requests.push(structuredClone(context.messages));
    return createAssistantResultStream(
      createAssistant(model, [{ type: "text", text: "Handled the completion." }]),
    );
  });
}

function submissionInput(
  leasedExecSteering:
    | { leaseId: string; itemIds: readonly string[]; isCurrent: () => boolean }
    | undefined,
  prompt: string,
) {
  const sessionPromptState = getEmbeddedSessionPromptState(sessionId);
  return {
    attempt: { sessionId, sessionKey: requesterSessionKey },
    contextTokenBudget: 32_000,
    images: [],
    leasedExecSteering,
    modelPrompt: prompt,
    transcriptPrompt: prompt,
    onFinalPromptText: vi.fn(),
    onSteeringAcknowledged: vi.fn(),
    onExecSteeringAcknowledged: vi.fn(),
    persistToolResultProjections: vi.fn(async () => {}),
    runtimeOnly: false,
    sessionPromptState,
    systemPrompt: "Use the exec results.",
    toolResultAggregateMaxChars: 8_000,
    toolResultMaxChars: 4_000,
    toolResultPromptProjectionState: sessionPromptState.toolResults,
    trajectoryRecorder: null,
    transcriptLeafId: null,
  };
}

function enqueueOwned(text: string, occurrenceKey: string, execId: string): void {
  enqueueExecSteeringCompletion({
    requesterSessionKey,
    ownerAgentId: "research",
    occurrenceKey,
    execId,
    status: "completed",
    exitLabel: "exit 0",
    text,
  });
}

it("delivers the owning agent's completion into the provider request exactly once", async () => {
  enqueueSystemEventEntry("Exec completed (owned001, exit 0) :: BUILD OK", {
    sessionKey: "agent:research:global",
    contextKey: "exec:owned001",
  });
  enqueueOwned("BUILD OK", "exec:owned001", "owned001");
  const leased = leasePendingExecSteeringItems({
    requesterSessionKey,
    ownerAgentId: "research",
    leaseId,
  });
  if (!leased) {
    throw new Error("Expected a leased exec completion");
  }
  expect(leased.isCurrent()).toBe(true);

  const requests: Context["messages"][] = [];
  recordProviderRequests(requests);
  const { session } = await createTestSession();
  const input = submissionInput(
    { ...leased, leaseId },
    prependExecSteeringPrompt({ steeringPrompt: leased.prompt, prompt: "Continue the work." }),
  );
  await submitEmbeddedAttemptPrompt({
    ...input,
    activeSession: session,
    promptActiveSession: (prompt, options) => session.prompt(prompt, options),
  });

  // The completion reached the provider request, and the steered turn retired
  // the durable event that shares its occurrence: a later heartbeat or terminal
  // poll finds nothing to deliver.
  expect(requests).toHaveLength(1);
  expect(JSON.stringify(requests[0])).toContain("BUILD OK");
  expect(input.onExecSteeringAcknowledged).toHaveBeenCalledOnce();
  expect(peekSystemEventEntries("agent:research:global")).toEqual([]);
  expect(
    leasePendingExecSteeringItems({
      requesterSessionKey,
      ownerAgentId: "research",
      leaseId: "next",
    }),
  ).toBeUndefined();
});

it("refuses another agent's copy of a shared global key before provider I/O", async () => {
  enqueueOwned("RESEARCH SECRET OUTPUT", "exec:secret01", "secret01");

  // The main agent shares the literal `global` key but owns a different queue,
  // so it can never lease the research agent's output.
  expect(
    leasePendingExecSteeringItems({ requesterSessionKey, ownerAgentId: "main", leaseId: "main" }),
  ).toBeUndefined();

  const requests: Context["messages"][] = [];
  recordProviderRequests(requests);
  const { session } = await createTestSession();
  const input = submissionInput(undefined, "Continue the work.");
  await submitEmbeddedAttemptPrompt({
    ...input,
    activeSession: session,
    promptActiveSession: (prompt, options) => session.prompt(prompt, options),
  });

  expect(requests).toHaveLength(1);
  expect(JSON.stringify(requests[0])).not.toContain("RESEARCH SECRET OUTPUT");
  expect(input.onExecSteeringAcknowledged).not.toHaveBeenCalled();

  // The owner still receives its own output.
  const owned = leasePendingExecSteeringItems({
    requesterSessionKey,
    ownerAgentId: "research",
    leaseId,
  });
  expect(owned?.prompt).toContain("RESEARCH SECRET OUTPUT");
});

it("rejects an already-leased copy acknowledged elsewhere before provider dispatch", async () => {
  enqueueOwned("RACED OUTPUT", "exec:raced01", "raced01");
  const leased = leasePendingExecSteeringItems({
    requesterSessionKey,
    ownerAgentId: "research",
    leaseId,
  });
  if (!leased) {
    throw new Error("Expected a leased exec completion");
  }
  // A terminal poll or heartbeat acknowledged the shared occurrence between
  // lease and dispatch, so the lease loses authority.
  expect(invalidateExecSteeringByOccurrence("exec:raced01")).toBe(1);
  expect(leased.isCurrent()).toBe(false);

  const requests: Context["messages"][] = [];
  recordProviderRequests(requests);
  const { session } = await createTestSession();
  const input = submissionInput(
    { ...leased, leaseId },
    prependExecSteeringPrompt({ steeringPrompt: leased.prompt, prompt: "Continue the work." }),
  );
  await expect(
    submitEmbeddedAttemptPrompt({
      ...input,
      activeSession: session,
      promptActiveSession: (prompt, options) => session.prompt(prompt, options),
    }),
  ).rejects.toThrow(
    "The queued exec completion lost authority before requester prompt submission.",
  );

  expect(streamMocks.streamSimple).not.toHaveBeenCalled();
  expect(requests).toEqual([]);
  expect(input.onExecSteeringAcknowledged).not.toHaveBeenCalled();
});
