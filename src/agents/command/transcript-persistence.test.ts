import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { getReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import {
  findTranscriptEvent,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import type { CliOutput } from "../cli-output-contracts.js";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import { buildCliRunResult } from "../cli-runner/cli-run-settlement.js";
import { prepareCliRunTerminalReply } from "../cli-runner/terminal-reply.js";
import { SessionManager } from "../sessions/session-manager.js";
import {
  persistAcpTurnTranscript,
  persistCliTurnTranscript,
  resolveCliTranscriptReplyText,
} from "./transcript-persistence.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-coordination-fallback-");

async function createSession(body = "Write the report", subagent = false) {
  const cwd = sessionDirs.make();
  const sessionId = "test-session";
  const sessionEntry = { sessionId, updatedAt: Date.now() };
  const common = {
    agentId: "main",
    sessionId,
    sessionKey: `agent:main:${subagent ? "subagent:" : ""}${sessionId}`,
    storePath: path.join(cwd, "openclaw-agent.sqlite"),
    body,
    sessionEntry,
    sessionAgentId: "main",
    sessionCwd: cwd,
    config: {},
  };
  await upsertSessionEntryCore(common, sessionEntry);
  return { ...common, sessionStore: { [common.sessionKey]: sessionEntry } };
}

function assistantMessage(text: string) {
  return { role: "assistant", content: [{ type: "text", text }] };
}

type TranscriptContext = Omit<Parameters<typeof persistCliTurnTranscript>[0], "result">;

const PEER_RESULT_FINAL = "The worker result is ready.";

function buildOptionalPeerResult(sessionKey: string, options: { sourceReplyFinal?: boolean } = {}) {
  const context = buildPreparedCliRunContext({ sessionKey, runId: "peer-result-producer" });
  context.params.sourceReplyDeliveryMode = "message_tool_only";
  context.params.terminalReplyExpectation = "optional";
  const output = {
    text: options.sourceReplyFinal ? PEER_RESULT_FINAL : "Starting.\n\nStill working.",
    rawFinalText: PEER_RESULT_FINAL,
    didSendViaMessagingTool: true,
    didDeliverSourceReplyViaMessageTool: true,
    messagingToolSourceReplyPayloads: options.sourceReplyFinal
      ? [{ text: PEER_RESULT_FINAL, sourceReplyFinal: true }]
      : [
          { text: "Starting.", sourceReplyFinal: false },
          { text: "Still working.", sourceReplyFinal: false },
        ],
  } satisfies CliOutput;
  const preparedReply = prepareCliRunTerminalReply(context, output);
  return buildCliRunResult({
    context,
    output,
    preparedReply,
    effectiveCliSessionId: "native-session",
    bindingFlushOk: true,
    usedHistoryPrompt: false,
    userTurnHandled: true,
    sessionBindingDisabled: false,
    preparedContextAgentMeta: {},
  });
}

function persist(runtime: string, common: TranscriptContext, finalText: string, hidden = false) {
  return runtime === "CLI"
    ? persistCliTurnTranscript({
        ...common,
        result: { payloads: [{ text: finalText }], meta: { durationMs: 0 } },
        skipUserTurn: hidden,
      })
    : persistAcpTurnTranscript({
        ...common,
        finalText,
        terminalOutcome: { reason: "completed", status: "ok" },
        prepareAssistantTranscriptMessage: hidden
          ? (message) => ({ ...message, display: true })
          : undefined,
      });
}

it.each([
  { runtime: "CLI", sourceTool: "sessions_send" },
  { runtime: "ACP", sourceTool: "sessions_send" },
  { runtime: "CLI", sourceTool: "subagent_settle", privateCompletion: true as const },
  { runtime: "ACP", sourceTool: "subagent_settle", privateCompletion: true as const },
])("hides $runtime $sourceTool fallback", async ({ runtime, sourceTool, privateCompletion }) => {
  const common = {
    ...(await createSession("Review the worker result")),
    privateCompletion,
    inputProvenance: {
      kind: "inter_session" as const,
      sourceTool,
      sourceRole: "subagent" as const,
    },
  };
  await persist(runtime, common, "Report received", true);
  const messages = SessionManager.open(common).buildSessionContext().messages;
  expect(messages).toHaveLength(runtime === "CLI" ? 1 : 2);
  expect(messages.at(-1)).toMatchObject(assistantMessage("Report received"));
  expect(messages.every((message) => Reflect.get(message, "display") === false)).toBe(true);
});

it.each(["CLI", "ACP"] as const)("recovers full %s answer after a later turn", async (runtime) => {
  const runId = `run-${runtime.toLowerCase()}-final`;
  const common = await createSession(undefined, true);
  const finalText = `${"line of the child report\n".repeat(400)}END-MARKER`;
  for (const turn of [
    { runId, finalText },
    { runId: `${runId}-later`, finalText: "A different turn's answer" },
  ]) {
    await persist(runtime, { ...common, runId: turn.runId }, turn.finalText);
  }
  const found = await findTranscriptEvent(common, { kind: "visible-final", runId });
  expect(found?.event).toMatchObject({
    message: { ...assistantMessage(finalText), __openclaw: { runId } },
  });
});

it("persists the CLI answer instead of delivered progress sends for an optional peer-result turn", async () => {
  const common = await createSession("Review the worker result");
  const result = buildOptionalPeerResult(common.sessionKey);
  const mirrorMetadata = (result.payloads ?? []).map((payload) => getReplyPayloadMetadata(payload));

  expect(mirrorMetadata).toHaveLength(2);
  expect(mirrorMetadata).toEqual([
    expect.objectContaining({
      sourceReplyFinal: false,
      sourceReplyTranscriptMirror: expect.objectContaining({ text: "Starting." }),
    }),
    expect.objectContaining({
      sourceReplyFinal: false,
      sourceReplyTranscriptMirror: expect.objectContaining({ text: "Still working." }),
    }),
  ]);
  expect(result.meta.finalAssistantMessageRawText).toBe(PEER_RESULT_FINAL);
  expect(resolveCliTranscriptReplyText(result)).toBe(PEER_RESULT_FINAL);

  await persistCliTurnTranscript({ ...common, result });

  const messages = SessionManager.open(common).buildSessionContext().messages;
  const assistantMessages = messages.filter((message) => message.role === "assistant");
  expect(assistantMessages).toHaveLength(1);
  expect(assistantMessages[0]).toMatchObject(assistantMessage(PEER_RESULT_FINAL));
});

it("keeps an explicit final source reply mirror delivery-owned", () => {
  const result = buildOptionalPeerResult("agent:qa:qa:peer-result-final", {
    sourceReplyFinal: true,
  });

  expect(getReplyPayloadMetadata(result.payloads?.[0] as object)).toMatchObject({
    sourceReplyFinal: true,
  });
  expect(resolveCliTranscriptReplyText(result)).toBe("");
});
