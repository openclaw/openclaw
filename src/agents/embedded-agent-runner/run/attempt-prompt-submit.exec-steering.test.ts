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
  enqueueSystemEventReceipt,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../../../infra/system-events.js";
import {
  enqueueExecSteeringCompletion,
  type ExecSteeringDeliverySettlement,
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
import { createResourceLoader } from "../../sessions/agent-session-loop-resource-loader.test-support.js";
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

function enqueueOwned(
  text: string,
  occurrenceKey: string,
  execId: string,
  durableEventId?: string,
): void {
  enqueueExecSteeringCompletion({
    requesterSessionKey,
    ownerAgentId: "research",
    occurrenceKey,
    ...(durableEventId ? { durableEventId } : {}),
    execId,
    status: "completed",
    exitLabel: "exit 0",
    text,
  });
}

it("delivers the owning agent's completion into the provider request exactly once", async () => {
  // The durable event and its steering copy share one globally-unique id, as
  // the exec runtime's notification path binds them.
  const receipt = enqueueSystemEventReceipt(
    "Exec completed (owned001, exit 0) :: BUILD OK",
    { sessionKey: "agent:research:global", contextKey: "exec:owned001" },
    { allowDuplicate: true },
  );
  if (!receipt) {
    throw new Error("Expected a durable system event receipt");
  }
  enqueueOwned("BUILD OK", "exec:owned001", "owned001", receipt.eventId);
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

it.each([true, false])(
  "holds a dispatched completion for its delivery owner, which settles it (delivered %s)",
  async (delivered) => {
    const receipt = enqueueSystemEventReceipt(
      "Exec completed (held0001, exit 0) :: HELD OUTPUT",
      { sessionKey: "agent:research:global", contextKey: "exec:held0001" },
      { allowDuplicate: true },
    );
    if (!receipt) {
      throw new Error("Expected a durable system event receipt");
    }
    enqueueOwned("HELD OUTPUT", "exec:held0001", "held0001", receipt.eventId);
    const leased = leasePendingExecSteeringItems({
      requesterSessionKey,
      ownerAgentId: "research",
      leaseId,
    });
    if (!leased) {
      throw new Error("Expected a leased exec completion");
    }

    const requests: Context["messages"][] = [];
    recordProviderRequests(requests);
    const { session } = await createTestSession();
    const settlements: ExecSteeringDeliverySettlement[] = [];
    const input = submissionInput(
      { ...leased, leaseId },
      prependExecSteeringPrompt({ steeringPrompt: leased.prompt, prompt: "Continue the work." }),
    );
    await submitEmbeddedAttemptPrompt({
      ...input,
      activeSession: session,
      promptActiveSession: (prompt, options) => session.prompt(prompt, options),
      onExecSteeringDispatched: (settlement) => {
        settlements.push(settlement);
      },
    });

    // The provider saw the completion, but the reply has not been delivered:
    // the durable event stays and no other turn can lease the held copy.
    expect(JSON.stringify(requests[0])).toContain("HELD OUTPUT");
    expect(settlements).toHaveLength(1);
    expect(peekSystemEventEntries("agent:research:global").map((event) => event.id)).toEqual([
      receipt.eventId,
    ]);
    expect(
      leasePendingExecSteeringItems({
        requesterSessionKey,
        ownerAgentId: "research",
        leaseId: "concurrent",
        now: Date.now() + 24 * 60 * 60 * 1000,
      }),
    ).toBeUndefined();

    settlements[0]?.settle(delivered);

    const next = leasePendingExecSteeringItems({
      requesterSessionKey,
      ownerAgentId: "research",
      leaseId: "next-turn",
    });
    if (delivered) {
      expect(peekSystemEventEntries("agent:research:global")).toEqual([]);
      expect(next).toBeUndefined();
    } else {
      // A failed or suppressed reply returns both copies for recovery.
      expect(peekSystemEventEntries("agent:research:global").map((event) => event.id)).toEqual([
        receipt.eventId,
      ]);
      expect(next?.prompt).toContain("HELD OUTPUT");
    }
  },
);

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

it("keeps the completion queued when an input extension handles the prompt", async () => {
  const receipt = enqueueSystemEventReceipt(
    "Exec completed (handled1, exit 0) :: HANDLED OUTPUT",
    { sessionKey: "agent:research:global", contextKey: "exec:handled1" },
    { allowDuplicate: true },
  );
  if (!receipt) {
    throw new Error("Expected a durable system event receipt");
  }
  enqueueOwned("HANDLED OUTPUT", "exec:handled1", "handled1", receipt.eventId);
  const leased = leasePendingExecSteeringItems({
    requesterSessionKey,
    ownerAgentId: "research",
    leaseId,
  });
  if (!leased) {
    throw new Error("Expected a leased exec completion");
  }

  const requests: Context["messages"][] = [];
  recordProviderRequests(requests);
  // An input extension handles AgentSession.prompt, which then returns
  // normally without runAgentPrompt or any provider request.
  const handlers = new Map<string, Array<() => Promise<unknown>>>([
    ["input", [async () => ({ action: "handled" })]],
  ]);
  const { session } = await createTestSession({ resourceLoader: createResourceLoader(handlers) });
  const input = submissionInput(
    { ...leased, leaseId },
    prependExecSteeringPrompt({ steeringPrompt: leased.prompt, prompt: "Continue the work." }),
  );
  await submitEmbeddedAttemptPrompt({
    ...input,
    activeSession: session,
    promptActiveSession: (prompt, options) => session.prompt(prompt, options),
  });

  // Nothing reached the provider, so nothing was acknowledged: the durable
  // event is still pending and the steering copy is back in the queue.
  expect(streamMocks.streamSimple).not.toHaveBeenCalled();
  expect(requests).toEqual([]);
  expect(peekSystemEventEntries("agent:research:global").map((event) => event.id)).toEqual([
    receipt.eventId,
  ]);
  const next = leasePendingExecSteeringItems({
    requesterSessionKey,
    ownerAgentId: "research",
    leaseId: "next-turn",
  });
  expect(next?.prompt).toContain("HANDLED OUTPUT");
});

it("rejects an already-leased copy acknowledged elsewhere before provider dispatch", async () => {
  const receipt = enqueueSystemEventReceipt(
    "Exec completed (raced01, exit 0) :: RACED OUTPUT",
    { sessionKey: "agent:research:global", contextKey: "exec:raced01" },
    { allowDuplicate: true },
  );
  if (!receipt) {
    throw new Error("Expected a durable system event receipt");
  }
  enqueueOwned("RACED OUTPUT", "exec:raced01", "raced01", receipt.eventId);
  const leased = leasePendingExecSteeringItems({
    requesterSessionKey,
    ownerAgentId: "research",
    leaseId,
  });
  if (!leased) {
    throw new Error("Expected a leased exec completion");
  }
  // A terminal poll or heartbeat settled the shared occurrence by its durable
  // id between lease and dispatch, so the lease loses authority.
  expect(receipt.remove()).toBe(true);
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
