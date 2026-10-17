import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateWithMarker } from "@openclaw/normalization-core/utf16-slice";
import { stripInternalMetadataForDisplay } from "../auto-reply/reply/display-text-sanitize.js";
import { stripMixedSilentReplyTokens } from "../auto-reply/reply/mixed-silent-reply-tokens.js";
import { isSilentReplyText } from "../auto-reply/tokens.js";
import { normalizeAgentRunRouteChange } from "./agent-run-terminal-receipt.js";
import type { AgentRunTerminalReplySnapshot } from "./agent-run-terminal-reply.types.js";

const AGENT_RUN_TERMINAL_REPLY_MAX_CHARS = 4_096;

function isMessageToolNotCalledTerminalReply(
  reply: AgentRunTerminalReplySnapshot | undefined,
): boolean {
  return reply?.disposition === "empty" && reply.code === "message-tool-not-called";
}

/** Sanitizes and caps known-visible text without classifying silence. */
export function sanitizeAgentRunTerminalReply(rawText: string): AgentRunTerminalReplySnapshot {
  const visibleText = stripInternalMetadataForDisplay(rawText).trim();
  const text = truncateWithMarker(visibleText, AGENT_RUN_TERMINAL_REPLY_MAX_CHARS, {
    marker: "…",
    reserve: 1,
    trimEnd: true,
  });
  if (!text) {
    return { disposition: "empty" };
  }
  return { disposition: "visible", text };
}

export type PreparedAgentRunTerminalReply = {
  text: string;
  terminalReply: AgentRunTerminalReplySnapshot;
};

/** Returns full prepared text, or undefined for an explicitly silent reply. */
export function prepareAgentRunReplyText(rawText: string): string | undefined {
  if (isSilentReplyText(rawText)) {
    return undefined;
  }
  return stripMixedSilentReplyTokens(rawText) ?? rawText.replace(/[\r\n]\s*NO_REPLY\s*$/iu, "");
}

export function prepareAgentRunTerminalReply(params: {
  rawText?: string;
}): PreparedAgentRunTerminalReply {
  const text = prepareAgentRunReplyText(params.rawText ?? "");
  return {
    text: text ?? "",
    terminalReply:
      text === undefined ? { disposition: "silent" } : sanitizeAgentRunTerminalReply(text),
  };
}

/** Normalizes lifecycle/RPC evidence without allowing raw or unbounded text through. */
export function normalizeAgentRunTerminalReplySnapshot(
  value: unknown,
): AgentRunTerminalReplySnapshot | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const disposition = value.disposition;
  if (disposition === "silent") {
    return { disposition };
  }
  if (disposition === "empty") {
    if (value.code === "message-tool-not-called") {
      return { disposition, code: "message-tool-not-called" };
    }
    return { disposition };
  }
  if (disposition !== "visible") {
    return undefined;
  }
  const rawText = value.text;
  if (typeof rawText !== "string") {
    return undefined;
  }
  const snapshot = sanitizeAgentRunTerminalReply(rawText);
  if (snapshot.disposition === "visible") {
    const modelRouteChange = normalizeAgentRunRouteChange(value.modelRouteChange);
    if (modelRouteChange) {
      snapshot.modelRouteChange = modelRouteChange;
    }
  }
  return snapshot;
}

/** Reply evidence merges independently from sticky timeout/cancellation precedence. */
export function mergeAgentRunTerminalReplySnapshot(
  existing: AgentRunTerminalReplySnapshot | undefined,
  incoming: AgentRunTerminalReplySnapshot | undefined,
): AgentRunTerminalReplySnapshot | undefined {
  if (!incoming || isMessageToolNotCalledTerminalReply(existing)) {
    return existing;
  }
  if (
    !existing ||
    isMessageToolNotCalledTerminalReply(incoming) ||
    existing.disposition === "empty"
  ) {
    return incoming;
  }
  return incoming.disposition === "empty" ? existing : incoming;
}
