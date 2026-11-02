// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useSubagentControlFixture } from "./subagent-control.test-support.js";
import { expect, it, onTestFinished } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { captureSessionTranscriptTargetBinding } from "../../../config/sessions/transcript-target-binding.js";
import { waitForAgentJob } from "../../../gateway/agent-turn/agent-job.js";
import { emitAgentEvent, getAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import {
  clearAgentRunContext,
  registerAgentRunContext,
} from "../../../infra/agent-run-registry.js";
import { prepareAgentRunTerminalReply } from "../../agent-run-terminal-reply.js";
import { readSubagentRunFinalAnswer } from "../announce/subagent-announce-output.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { subscribeSubagentRunChanges } from "./subagent-registry-publication.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
import { registerSubagentRun, replaceSubagentRunAfterSteerCore } from "./subagent-registry.js";
import { writeSubagentSessionEntry } from "./subagent-registry.persistence.test-support.js";
import { updateSubagentRunFixture } from "./subagent-registry.run-fixtures.test-support.js";

const fixture = useSubagentControlFixture();

it("replays a successor completed before registration without replacing its predecessor's answer", async () => {
  const previousRunId = "completed-before-registration-old";
  const nextRunId = "completed-before-registration-next";
  const childSessionKey = "agent:main:subagent:completed-before-registration";
  const sessionId = "completed-before-registration-session";
  const previousAnswer = "The predecessor's independent answer.";
  const fullAnswer = `${"Successor report. ".repeat(400)}required-final-suffix`;
  const prepared = prepareAgentRunTerminalReply({ rawText: fullAnswer });
  const startedAt = Date.now();
  const endedAt = startedAt + 1;
  fixture.announce.mockResolvedValue("delivered");
  fixture.gateway.mockImplementation(async (request) => {
    if (request.method !== "agent.wait") {
      throw new Error(`Unexpected registry RPC ${request.method}`);
    }
    const params = request.params;
    if (!params || typeof params !== "object" || !("runId" in params)) {
      throw new Error("Missing agent.wait runId");
    }
    if (params.runId === previousRunId) {
      return { status: "pending" };
    }
    expect(params.runId).toBe(nextRunId);
    const observed = await waitForAgentJob({ runId: nextRunId, timeoutMs: 0 });
    if (!observed) {
      throw new Error("Successor terminal was not cached before registration");
    }
    return observed;
  });
  const writeSession = (sessionKey: string, defaultSessionId: string) =>
    writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey,
      defaultSessionId,
    });
  const storePath = await writeSession(childSessionKey, sessionId);
  await writeSession("agent:main:main", "completed-before-registration-requester");
  const sessionEntry = loadSessionEntry({ storePath, sessionKey: childSessionKey });
  if (!sessionEntry) {
    throw new Error("Missing child fixture session");
  }
  const transcript = captureSessionTranscriptTargetBinding({
    agentId: "main",
    sessionKey: childSessionKey,
    sessionId,
    storePath,
  });
  await registerSubagentRun({
    runId: previousRunId,
    childSessionKey,
    childAgentId: "main",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "completed successor replay",
    cleanup: "keep",
    sessionEntry,
    spawnMode: "session",
    expectsCompletionMessage: true,
  });
  await updateSubagentRunFixture(previousRunId, (draft) => {
    draft.execution = {
      ...draft.execution,
      status: "terminal",
      startedAt: startedAt - 2,
      endedAt: startedAt - 1,
      outcome: { status: "ok" },
      transcriptTarget: transcript,
    };
    draft.completion = {
      required: true,
      resultText: previousAnswer,
      capturedAt: startedAt - 1,
      terminalReply: { disposition: "visible", text: previousAnswer },
    };
    // This test observes successor completion, not predecessor delivery.
    draft.cleanupHandled = true;
  });
  await fixture.settle();
  const previous = subagentRuns.get(previousRunId);
  if (!previous) {
    throw new Error("Missing predecessor registry owner");
  }
  const previousCompletion = structuredClone(
    loadSubagentRegistryFromSqlite().get(previousRunId)?.completion,
  );
  expect(previousCompletion?.resultText).toBe(previousAnswer);
  for (const [runId, content] of [
    [previousRunId, previousAnswer],
    [nextRunId, prepared.text],
    ["unrelated-later-run", "A newer message belonging to another run."],
  ]) {
    await appendTranscriptMessage(transcript, {
      message: { role: "assistant", content, stopReason: "stop", __openclaw: { runId } },
    });
  }
  registerAgentRunContext(nextRunId, {
    agentId: "main",
    sessionKey: childSessionKey,
    sessionId,
    lifecycleGeneration: getAgentEventLifecycleGeneration(),
  });
  onTestFinished(() => clearAgentRunContext(nextRunId));
  expect(await waitForAgentJob({ runId: nextRunId, timeoutMs: 0 })).toBeNull();
  expect(subagentRuns.has(nextRunId)).toBe(false);
  emitAgentEvent({
    runId: nextRunId,
    stream: "lifecycle",
    data: {
      phase: "end",
      executionSettled: true,
      status: "ok",
      startedAt,
      endedAt,
      terminalReply: prepared.terminalReply,
    },
  });
  expect(await waitForAgentJob({ runId: nextRunId, timeoutMs: 0 })).toMatchObject({
    status: "ok",
    startedAt,
    endedAt,
  });
  const persisted = createDeferred();
  onTestFinished(
    subscribeSubagentRunChanges("persistence", () => {
      if (subagentRuns.get(nextRunId)?.execution.status === "terminal") {
        persisted.resolve();
      }
    }),
  );
  expect(
    await replaceSubagentRunAfterSteerCore({
      previousRunId,
      nextRunId,
      expected: previous,
      allowEndedSource: true,
      preserveCompletedRun: true,
      sessionEntry,
      transcriptTarget: transcript,
    }),
  ).toBe(true);
  await persisted.promise;
  await fixture.settle();
  const stored = loadSubagentRegistryFromSqlite();
  const successor = stored.get(nextRunId);
  if (!successor) {
    throw new Error("Missing persisted successor");
  }
  expect(successor.taskRunId).toBe(nextRunId);
  expect(successor.execution.status).toBe("terminal");
  const preview = successor.completion?.terminalReply;
  if (preview?.disposition !== "visible") {
    throw new Error("Missing bounded successor preview");
  }
  expect(preview.text.length).toBeLessThanOrEqual(4096);
  expect(preview.text).not.toContain("required-final-suffix");
  await expect(readSubagentRunFinalAnswer(successor)).resolves.toBe(fullAnswer);
  expect(stored.get(previousRunId)?.completion).toEqual(previousCompletion);
});
