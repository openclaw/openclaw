import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { stripInternalMetadataForDisplay } from "../../../auto-reply/reply/display-text-sanitize.js";
import { parseReplyDirectives } from "../../../auto-reply/reply/reply-directives.js";
import {
  readOrPreserveRecoveredSessionResult,
  type SessionRecoveredResultTarget,
} from "../../../config/sessions/session-recovered-result.js";
import type { AssistantHistoryMessage } from "../../../llm/types.js";
import {
  OPENCLAW_TRANSCRIPT_ARTIFACT_API,
  OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER,
} from "../../../shared/transcript-only-openclaw-assistant.js";
import { extractTtsDirectiveFacts } from "../../../tts/directive-facts.js";
import { sanitizeAgentRunTerminalReply } from "../../agent-run-terminal-reply.js";
import type { AgentRunTerminalReplySnapshot } from "../../agent-run-terminal-reply.types.js";
import { prepareTerminalAssistantReply } from "../../assistant-terminal-reply.js";
import { extractStoredAssistantText } from "../../tools/chat-history-text.js";
import { makeZeroUsageSnapshot } from "../../usage.js";

const RECOVERED_REPLY_MODEL = "recovered-reply";

type AssistantRow = Record<string, unknown>;

function isCleanRecoveredReply(message: AssistantRow, text: string): boolean {
  const content = message["content"];
  const block =
    Array.isArray(content) && content.length === 1 ? asOptionalRecord(content[0]) : undefined;
  return (
    message["api"] === OPENCLAW_TRANSCRIPT_ARTIFACT_API &&
    message["provider"] === OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER &&
    message["model"] === RECOVERED_REPLY_MODEL &&
    message["phase"] === "final_answer" &&
    message["display"] === true &&
    typeof message["idempotencyKey"] === "string" &&
    Boolean(message["idempotencyKey"]) &&
    block?.["type"] === "text" &&
    block["text"] === text &&
    stripInternalMetadataForDisplay(text) === text
  );
}

async function findOrPreserveRecoveredReply(
  target: SessionRecoveredResultTarget,
  write?: { text: string; idempotencyKey: string },
): Promise<AgentRunTerminalReplySnapshot | undefined> {
  const saved = await readOrPreserveRecoveredSessionResult(
    target,
    RECOVERED_REPLY_MODEL,
    write && {
      idempotencyKey: write.idempotencyKey,
      message: createRecoveredMessage(target.runId, write),
    },
  );
  if (!saved) {
    return undefined;
  }
  target.assertCurrent();
  const text = extractStoredAssistantText(saved)?.trim();
  if (
    saved.role !== "assistant" ||
    saved.stopReason !== "stop" ||
    asOptionalRecord(saved["__openclaw"])?.runTerminal !== true ||
    !text ||
    (write ? write.text !== text : !isCleanRecoveredReply(saved, text))
  ) {
    throw new Error("Saved worker answer conflicts with the recovered reply");
  }
  return sanitizeAgentRunTerminalReply(text);
}

function createRecoveredMessage(runId: string, write: { text: string; idempotencyKey: string }) {
  const { cost: _cost, ...usage } = makeZeroUsageSnapshot();
  return {
    role: "assistant",
    content: [{ type: "text", text: write.text }],
    phase: "final_answer",
    display: true,
    stopReason: "stop",
    timestamp: Date.now(),
    api: OPENCLAW_TRANSCRIPT_ARTIFACT_API,
    provider: OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER,
    model: RECOVERED_REPLY_MODEL,
    usage: { ...usage, usageReport: { state: "unavailable" } },
    idempotencyKey: write.idempotencyKey,
    __openclaw: { runId, runTerminal: true },
  } satisfies AssistantHistoryMessage & Record<string, unknown>;
}

/** Reconcile a reply already committed by recovery before doing any native lookup. */
export async function readRecoveredSubagentReply(
  input: SessionRecoveredResultTarget,
): Promise<AgentRunTerminalReplySnapshot | undefined> {
  return findOrPreserveRecoveredReply(input);
}

/** Retain the attested final under its original writer before publishing run completion. */
export async function preserveRecoveredSubagentReply({
  rawText,
  idempotencyKey,
  ...input
}: SessionRecoveredResultTarget & { rawText: string; idempotencyKey: string }): Promise<
  AgentRunTerminalReplySnapshot | undefined
> {
  input.assertCurrent();
  const prepared = prepareTerminalAssistantReply({
    content: rawText,
    phase: "final_answer",
    stopReason: "stop",
  });
  if (!idempotencyKey || prepared.terminalReply.disposition !== "visible") {
    return undefined;
  }
  const directives = parseReplyDirectives(prepared.text, { extractMarkdownImages: false });
  const text = stripInternalMetadataForDisplay(
    extractTtsDirectiveFacts(directives.text).cleanedText,
  ).trim();
  if (sanitizeAgentRunTerminalReply(text).disposition !== "visible") {
    return undefined;
  }
  return findOrPreserveRecoveredReply(input, { text, idempotencyKey });
}
