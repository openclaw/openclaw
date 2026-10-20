// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useSubagentControlFixture } from "../../subagents/registry/subagent-control.test-support.js";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import path from "node:path";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import {
  appendTranscriptMessage,
  deleteSessionEntryLifecycle,
} from "../../../config/sessions/session-accessor.js";
import {
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../../../config/sessions/session-accessor.sqlite-scope.js";
import { pruneAllSessionTranscriptArchivesToHighWater } from "../../../config/sessions/session-history-archive-pruning.js";
import { findSessionTranscriptArchiveEventReadOnly } from "../../../config/sessions/session-history.js";
import { reactivateCompletedSubagentSession } from "../../../gateway/session-subagent-reactivation.js";
import { matchesTranscriptEvent } from "../../../sessions/transcript-visible-record.js";
import { prepareAgentRunTerminalReply } from "../../agent-run-terminal-reply.js";
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
import { markPendingFinalDelivery } from "../../subagent-test-fixtures.test-helpers.js";
import { testing as announceTesting } from "../../subagents/announce/subagent-announce-output.test-support.js";
import {
  ensureDeliveryState,
  loadPendingFinalDeliveryPayload,
} from "../../subagents/registry/subagent-delivery-state.js";
import { subagentRuns } from "../../subagents/registry/subagent-registry-memory.js";
import { mutateSubagentRuns } from "../../subagents/registry/subagent-registry-persistence.js";
import {
  leasePendingAgentSteeringItems,
  prependAgentSteeringPrompt,
  registerSubagentRun,
  releasePendingAgentSteeringItems,
} from "../../subagents/registry/subagent-registry.js";
import { writeSubagentSessionEntry } from "../../subagents/registry/subagent-registry.persistence.test-support.js";
import { clearEmbeddedSessionPromptStates } from "../session-prompt-state.js";
import {
  handleEmbeddedAttemptPromptError,
  submitEmbeddedAttemptPrompt,
} from "./attempt-prompt-submit.js";
import { createBaseInput, sessionId } from "./attempt-prompt-submit.test-support.js";

const fixture = useSubagentControlFixture();
registerAgentSessionLoopTestLifecycle();

const requesterSessionKey = "agent:main:main";
const childRunId = "completed-child";
const childSessionKey = `agent:main:subagent:${childRunId}`;
const nextRunId = "child-follow-up";
const answer = `${"<finding>".repeat(700)}complete answer tail`;
const escapedAnswer = `${"&lt;finding&gt;".repeat(700)}complete answer tail`;
const lostAuthority = "The queued child results lost authority before requester prompt submission.";

function childMessage(runId: string, text: string) {
  return { ...createAssistant(testModel, text), __openclaw: { runId } };
}

afterEach(() => {
  announceTesting.setDepsForTest();
  clearEmbeddedSessionPromptStates([sessionId]);
});

async function prepareSteering() {
  const { terminalReply } = await publishChild(childRunId, answer, false);
  expect(terminalReply.text).toHaveLength(4_096);
  announceTesting.setDepsForTest({
    findTranscriptEvent: async (_target, match) => {
      const event = { type: "message", message: childMessage(childRunId, answer) };
      return matchesTranscriptEvent(event, match) ? { event } : undefined;
    },
  });
  const leaseId = "requester-steering";
  const leased = await leasePendingAgentSteeringItems({ requesterSessionKey, leaseId });
  assert(leased, "Expected queued child result");
  expect(leased.isCurrent()).toBe(true);
  expect(leased.prompt).toContain(escapedAnswer);
  return { ...leased, leaseId };
}

async function invalidateCompletion(error: string) {
  await mutateSubagentRuns([childRunId], (rows) => {
    const current = rows.get(childRunId);
    assert(current, "Expected child completion");
    const next = {
      ...current,
      execution: { ...current.execution, outcome: { status: "error" as const, error } },
    };
    return { value: undefined, postimages: new Map([[childRunId, next]]) };
  });
}

function submissionInput(leasedSteering: Awaited<ReturnType<typeof prepareSteering>>) {
  const prompt = prependAgentSteeringPrompt({
    steeringPrompt: leasedSteering.prompt,
    prompt: "Use the findings to finish the answer.",
  });
  return {
    ...createBaseInput(),
    attempt: { sessionId, sessionKey: requesterSessionKey },
    contextTokenBudget: 32_000,
    leasedSteering,
    modelPrompt: prompt,
    transcriptPrompt: prompt,
    appendContext: undefined,
    prependContext: undefined,
    systemPrompt: "Use the child findings.",
  };
}

const submit = (
  session: Awaited<ReturnType<typeof createTestSession>>["session"],
  input: ReturnType<typeof submissionInput>,
) =>
  submitEmbeddedAttemptPrompt({
    ...input,
    activeSession: session,
    promptActiveSession: (prompt, options) => session.prompt(prompt, options),
  });

it.each([false, true])(
  "preserves parent continuation and cancellation after child reactivation (abort=%s)",
  async (abort) => {
    const leasedSteering = await prepareSteering();
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
      expect(subagentRuns.get(childRunId)).toMatchObject({
        execution: { status: "terminal", suppressSessionEffects: true },
      });
      expect(subagentRuns.get(nextRunId)?.execution.status).toBe("running");
      expect(leasedSteering.isCurrent()).toBe(true);
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
            : "Parent answer complete.",
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
    await submit(session, input);

    expect(followUp).toHaveBeenCalledOnce();
    expect(subagentRuns.get(childRunId)).toMatchObject({
      execution: { status: "terminal", suppressSessionEffects: true },
      delivery: { status: "delivered" },
    });
    expect(subagentRuns.get(nextRunId)).toMatchObject({
      taskRunId: nextRunId,
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
  const leasedSteering = await prepareSteering();
  const { session } = await createTestSession();
  const input = submissionInput(leasedSteering);
  await invalidateCompletion("Completion invalidated.");
  expect(leasedSteering.isCurrent()).toBe(false);
  const releaseLeasedSteering = vi.fn(async (error?: unknown) => {
    await releasePendingAgentSteeringItems({ ...leasedSteering, error: String(error) });
  });
  const failed = submit(session, input);
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
      error: expect.objectContaining({ message: lostAuthority }),
    },
  });
  expect(streamMocks.streamSimple).not.toHaveBeenCalled();
  expect(releaseLeasedSteering).toHaveBeenCalledOnce();
  expect(input.onSteeringAcknowledged).not.toHaveBeenCalled();
  expect(subagentRuns.get(childRunId)?.delivery?.status).toBe("pending");
  expect(subagentRuns.get(childRunId)?.delivery?.steeringLeaseId).toBeUndefined();
});

it("keeps source validation until foreground delivery after pre-prompt compaction", async () => {
  const leasedSteering = await prepareSteering();
  const model = { ...testModel, contextWindow: 4_096, maxTokens: 512 };
  const sessionManager = SessionManager.inMemory();
  for (const [content, reply, timestamp] of [
    ["Earlier investigation details. ".repeat(650), "Earlier result.", 1],
    ["Keep the latest observation.", "Observation kept.", 3],
  ] as const) {
    sessionManager.appendMessage({ role: "user", content, timestamp });
    sessionManager.appendMessage(createAssistant(model, reply, "stop", 5_000));
  }
  const { session } = await createTestSession({
    model,
    sessionManager,
    settingsManager: createAutoCompactionSettings(),
  });
  // Keep checkout-dependent prompt paths out of this 4k compaction budget.
  session.setBaseSystemPrompt("Use the child findings.");
  const compacting: boolean[] = [];
  streamMocks.streamSimple.mockImplementation(async (activeModel: Model) => {
    compacting.push(session.isCompacting);
    await invalidateCompletion("Completion invalidated during compaction.");
    return createAssistantResultStream(
      createAssistant(activeModel, "Earlier investigation summarized."),
    );
  });
  await submit(session, submissionInput(leasedSteering));

  expect(compacting).toEqual([true]);
  expect(session.messages.at(-1)).toMatchObject({
    role: "assistant",
    stopReason: "error",
    errorMessage: lostAuthority,
  });
});

async function publishChild(runId: string, resultText: string, persistTranscript = true) {
  const publishedSessionKey = `agent:main:subagent:${runId}`;
  const childSessionId = `${runId}-session`;
  const target = {
    agentId: "main",
    sessionId: childSessionId,
    sessionKey: publishedSessionKey,
    storePath: await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: publishedSessionKey,
      defaultSessionId: childSessionId,
    }),
  };
  if (persistTranscript) {
    await appendTranscriptMessage(target, {
      message: childMessage(runId, resultText),
    });
  }
  await registerSubagentRun({
    runId,
    childSessionKey: publishedSessionKey,
    childAgentId: "main",
    sessionEntry: { sessionId: childSessionId },
    requesterSessionKey,
    requesterDisplayKey: "main",
    task: "Inspect the findings",
    cleanup: "keep",
    spawnMode: "session",
    expectsCompletionMessage: true,
  });
  const terminalReply = prepareAgentRunTerminalReply({ rawText: resultText }).terminalReply;
  assert(terminalReply.disposition === "visible", "Expected visible terminal reply");
  const child = await mutateSubagentRuns([runId], (rows) => {
    const current = rows.get(runId);
    assert(current, "Expected registered child");
    const next = structuredClone(current);
    next.execution = {
      ...next.execution,
      status: "terminal",
      endedAt: Date.now(),
      outcome: { status: "ok" },
      transcriptTarget: target,
    };
    next.completion = { required: true, resultText: terminalReply.text, terminalReply };
    if (persistTranscript) {
      markPendingFinalDelivery({ entry: next });
    } else {
      Object.assign(ensureDeliveryState(next), {
        status: "pending",
        payload: loadPendingFinalDeliveryPayload(next),
      });
    }
    return { value: next, postimages: new Map([[runId, next]]) };
  });
  return { child, target, terminalReply };
}

it("submits deferred child results after canonical archive pruning without poisoning the next parent turn", async () => {
  const archivedAnswer = `${"Archived finding. ".repeat(400)}archive answer tail`;
  const healthyAnswer = `${"Healthy finding. ".repeat(400)}healthy answer tail`;
  const archived = await publishChild("archived-child", archivedAnswer);
  const healthy = await publishChild("healthy-child", healthyAnswer);
  expect(archived.terminalReply.text.length).toBeLessThanOrEqual(4_096);
  expect(healthy.terminalReply.text.length).toBeLessThanOrEqual(4_096);
  expect(archived.terminalReply.text).not.toContain("archive answer tail");
  expect(healthy.terminalReply.text).not.toContain("healthy answer tail");
  const deleted = await deleteSessionEntryLifecycle({
    archiveTranscript: true,
    storePath: archived.target.storePath,
    target: {
      canonicalKey: archived.target.sessionKey,
      storeKeys: [archived.target.sessionKey],
    },
  });
  const archivePath = deleted.archivedTranscripts[0]?.archivedPath;
  assert(archivePath, "Expected published child transcript archive");
  await access(archivePath);
  expect(
    await findSessionTranscriptArchiveEventReadOnly(archived.target, archived.child.runId),
  ).toMatchObject({
    event: { message: { content: [{ type: "text", text: archivedAnswer }] } },
  });

  const scope = resolveSqliteReadScope(archived.target);
  const pruned = await pruneAllSessionTranscriptArchivesToHighWater({
    archiveDirectory: path.dirname(archivePath),
    databaseOptions: toDatabaseOptions(scope),
    highWaterBytes: 0,
    storePath: archived.target.storePath,
  });
  expect(pruned.removedFiles).toBe(1);
  await expect(access(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
  expect(
    await findSessionTranscriptArchiveEventReadOnly(archived.target, archived.child.runId),
  ).toBeUndefined();

  await writeSubagentSessionEntry({
    stateDir: fixture.stateDir,
    agentId: "main",
    sessionKey: archived.target.sessionKey,
    defaultSessionId: "replacement-session",
  });
  await appendTranscriptMessage(
    { ...archived.target, sessionId: "replacement-session" },
    { message: childMessage("replacement-run", "Unrelated replacement answer.") },
  );
  const leaseId = "retained-results";
  const leased = await leasePendingAgentSteeringItems({ requesterSessionKey, leaseId });
  assert(leased, "Expected both deferred child results");
  expect(leased.runIds).toEqual([archived.child.runId, healthy.child.runId]);
  expect(leased.isCurrent()).toBe(true);
  const { session } = await createTestSession();
  const requests: Context["messages"][] = [];
  streamMocks.streamSimple.mockImplementation((model: Model, context: Context) => {
    requests.push(structuredClone(context.messages));
    return createAssistantResultStream(createAssistant(model, "Parent answer complete."));
  });
  const input = submissionInput({ ...leased, leaseId });
  await submit(session, input);

  expect(requests).toHaveLength(1);
  const delivered = JSON.stringify(requests[0]);
  expect(delivered).toContain("truncated-by-retention");
  expect(delivered).toContain(archived.terminalReply.text);
  expect(delivered).not.toContain("archive answer tail");
  expect(delivered).toContain(healthyAnswer);
  expect(delivered).not.toContain("Unrelated replacement answer.");
  expect(input.onSteeringAcknowledged).toHaveBeenCalledOnce();
  for (const { child } of [archived, healthy]) {
    expect(subagentRuns.get(child.runId)?.delivery?.status).toBe("delivered");
    expect(subagentRuns.get(child.runId)?.delivery?.steeringLeaseId).toBeUndefined();
  }
  expect(
    await leasePendingAgentSteeringItems({ requesterSessionKey, leaseId: "next-turn" }),
  ).toBeUndefined();
  await session.prompt("Continue with the next question.");
  expect(requests).toHaveLength(2);
  expect(session.messages.at(-1)).toMatchObject({
    role: "assistant",
    stopReason: "stop",
    content: [{ type: "text", text: "Parent answer complete." }],
  });
  expect(session.messages).not.toContainEqual(
    expect.objectContaining({ role: "assistant", stopReason: "error" }),
  );
});
