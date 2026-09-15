import { access } from "node:fs/promises";
import path from "node:path";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { afterEach, expect, it, vi } from "vitest";
import {
  appendTranscriptMessage,
  deleteSessionEntryLifecycle,
} from "../../../config/sessions/session-accessor.js";
import {
  resolveSqliteReadScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "../../../config/sessions/session-accessor.sqlite-scope.js";
import { pruneAllSessionTranscriptArchivesToHighWater } from "../../../config/sessions/session-history-archive-pruning.js";
import { findSessionTranscriptArchiveEventReadOnly } from "../../../config/sessions/session-history.js";
import { buildAgentRunTerminalReplySnapshot } from "../../agent-run-terminal-reply.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { useSubagentControlFixture } from "../../subagents/registry/subagent-control.test-support.js";
import { markPendingFinalDelivery } from "../../subagents/registry/subagent-registry-lifecycle-delivery.js";
import { subagentRuns } from "../../subagents/registry/subagent-registry-memory.js";
import { persistSubagentRunsToDiskOrThrow } from "../../subagents/registry/subagent-registry-state.js";
import {
  leasePendingAgentSteeringItems,
  prependAgentSteeringPrompt,
  registerSubagentRun,
} from "../../subagents/registry/subagent-registry.js";
import { writeSubagentSessionEntry } from "../../subagents/registry/subagent-registry.persistence.test-support.js";
import {
  clearEmbeddedSessionPromptStates,
  getEmbeddedSessionPromptState,
} from "../session-prompt-state.js";
import { submitEmbeddedAttemptPrompt } from "./attempt-prompt-submit.js";

const fixture = useSubagentControlFixture();
registerAgentSessionLoopTestLifecycle();

const sessionId = "retention-requester";
const requesterSessionKey = "agent:main:main";

afterEach(() => clearEmbeddedSessionPromptStates([sessionId]));

async function publishChild(runId: string, answer: string) {
  const childSessionKey = `agent:main:subagent:${runId}`;
  const childSessionId = `${runId}-session`;
  const storePath = await writeSubagentSessionEntry({
    stateDir: fixture.stateDir,
    agentId: "main",
    sessionKey: childSessionKey,
    defaultSessionId: childSessionId,
  });
  const target = {
    agentId: "main",
    sessionId: childSessionId,
    sessionKey: childSessionKey,
    storePath,
  };
  await appendTranscriptMessage(target, {
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: answer }],
      __openclaw: { runId },
    },
  });
  registerSubagentRun({
    runId,
    childSessionKey,
    requesterSessionKey,
    requesterDisplayKey: "main",
    task: "Inspect the findings",
    cleanup: "keep",
    spawnMode: "session",
    expectsCompletionMessage: true,
  });
  const child = subagentRuns.get(runId);
  if (!child) {
    throw new Error("Expected registered child");
  }
  const terminalReply = buildAgentRunTerminalReplySnapshot({ visibleText: answer });
  if (terminalReply.disposition !== "visible") {
    throw new Error("Expected visible terminal reply");
  }
  child.execution = {
    ...child.execution,
    status: "terminal",
    endedAt: Date.now(),
    outcome: { status: "ok" },
    transcriptTarget: target,
  };
  child.completion = { required: true, resultText: terminalReply.text, terminalReply };
  markPendingFinalDelivery({ entry: child });
  persistSubagentRunsToDiskOrThrow(subagentRuns, [runId]);
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
  if (!archivePath) {
    throw new Error("Expected published child transcript archive");
  }
  await expect(access(archivePath)).resolves.toBeUndefined();
  expect(
    await findSessionTranscriptArchiveEventReadOnly(archived.target, archived.child.runId),
  ).toMatchObject({
    event: { message: { content: [{ type: "text", text: archivedAnswer }] } },
  });

  const scope = resolveSqliteReadScope(archived.target);
  const pruned = await runExclusiveSqliteSessionWrite(
    scope,
    () =>
      pruneAllSessionTranscriptArchivesToHighWater({
        archiveDirectory: path.dirname(archivePath),
        databaseOptions: toDatabaseOptions(scope),
        highWaterBytes: 0,
        storePath: archived.target.storePath,
      }),
    "session.history.archive-prune",
  );
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
    {
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "Unrelated replacement answer." }],
        __openclaw: { runId: "replacement-run" },
      },
    },
  );
  const leaseId = "retained-results";
  const leased = await leasePendingAgentSteeringItems({ requesterSessionKey, leaseId });
  if (!leased) {
    throw new Error("Expected both deferred child results");
  }
  expect(leased.runIds).toEqual([archived.child.runId, healthy.child.runId]);
  expect(leased.isCurrent()).toBe(true);
  const { session } = await createTestSession();
  const requests: Context["messages"][] = [];
  streamMocks.streamSimple.mockImplementation((model: Model, context: Context) => {
    requests.push(structuredClone(context.messages));
    return createAssistantResultStream(
      createAssistant(model, [{ type: "text", text: "Parent answer complete." }]),
    );
  });
  const onSteeringAcknowledged = vi.fn();
  const sessionPromptState = getEmbeddedSessionPromptState(sessionId);
  const prompt = prependAgentSteeringPrompt({
    steeringPrompt: leased.prompt,
    prompt: "Use the findings to finish the answer.",
  });
  await submitEmbeddedAttemptPrompt({
    attempt: { sessionId, sessionKey: requesterSessionKey },
    activeSession: session,
    contextTokenBudget: 32_000,
    images: [],
    leasedSteering: { ...leased, leaseId },
    modelPrompt: prompt,
    transcriptPrompt: prompt,
    onFinalPromptText: vi.fn(),
    onSteeringAcknowledged,
    persistToolResultProjections: vi.fn(async () => {}),
    promptActiveSession: (text, options) => session.prompt(text, options),
    runtimeOnly: false,
    sessionPromptState,
    systemPrompt: "Use the child findings.",
    toolResultAggregateMaxChars: 8_000,
    toolResultMaxChars: 4_000,
    toolResultPromptProjectionState: sessionPromptState.toolResults,
    trajectoryRecorder: null,
    transcriptLeafId: null,
  });

  expect(requests).toHaveLength(1);
  const delivered = JSON.stringify(requests[0]);
  expect(delivered).toContain("truncated-by-retention");
  expect(delivered).toContain(archived.terminalReply.text);
  expect(delivered).not.toContain("archive answer tail");
  expect(delivered).toContain(healthyAnswer);
  expect(delivered).not.toContain("Unrelated replacement answer.");
  expect(onSteeringAcknowledged).toHaveBeenCalledOnce();
  for (const { child } of [archived, healthy]) {
    expect(child.delivery?.status).toBe("delivered");
    expect(child.delivery?.steeringLeaseId).toBeUndefined();
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
  expect(
    session.messages.some(
      (message) => message.role === "assistant" && message.stopReason === "error",
    ),
  ).toBe(false);
});
