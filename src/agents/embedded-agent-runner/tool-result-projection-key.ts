import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sha256Base64Url } from "../../infra/crypto-digest.js";
import type { AgentMessage } from "../runtime/index.js";
import type { ToolResultPromptProjectionState } from "./session-prompt-state.js";

export const TOOL_RESULT_PROJECTION_KEY = Symbol("toolResultProjectionKey");

export function getToolResultProjectionBaseKey(message: AgentMessage): string | undefined {
  if (message.role !== "toolResult") {
    return undefined;
  }
  const toolCallId = message.toolCallId;
  const timestamp = message.timestamp;
  const timestampKey = typeof timestamp === "number" ? `:${timestamp}` : "";
  if (typeof toolCallId === "string" && toolCallId.length > 0) {
    return `tool:${toolCallId}${timestampKey}`;
  }
  return typeof timestamp === "number" ? `timestamp:${timestamp}` : undefined;
}

export function getToolResultProjectionKeys(
  messages: AgentMessage[],
  projectionState: ToolResultPromptProjectionState,
): Array<string | undefined> {
  const baseKeys = messages.map((message) => getToolResultProjectionBaseKey(message));
  const baseKeyCounts = new Map<string, number>();
  for (const baseKey of baseKeys) {
    if (baseKey) {
      const count = (baseKeyCounts.get(baseKey) ?? 0) + 1;
      baseKeyCounts.set(baseKey, count);
      if (count > 1) {
        projectionState.ambiguousBaseKeys.add(baseKey);
      }
    }
  }
  const occurrences = new Map<string, number>();
  return baseKeys.map((baseKey, index) => {
    const message = messages[index];
    if (
      message &&
      TOOL_RESULT_PROJECTION_KEY in message &&
      typeof message[TOOL_RESULT_PROJECTION_KEY] === "string"
    ) {
      return message[TOOL_RESULT_PROJECTION_KEY];
    }
    if (baseKey && !projectionState.ambiguousBaseKeys.has(baseKey)) {
      return baseKey;
    }
    if (!message || message.role !== "toolResult") {
      return undefined;
    }
    // Stable identities keep ambiguous tool ids from rewriting cache-tail projections (#99495).
    // SAFETY: Imported transcript messages may carry an entry id; only a string id is accepted below.
    const messageId = (message as { id?: unknown }).id;
    const sourceIdentity =
      typeof messageId === "string" && messageId.length > 0
        ? `id:${messageId}`
        : `text:${hashToolResultText(getToolResultTextBlocks(message))}`;
    const fallbackBase = `fallback:${baseKey ?? "tool"}:${sourceIdentity}`;
    const occurrence = occurrences.get(fallbackBase) ?? 0;
    occurrences.set(fallbackBase, occurrence + 1);
    const key = `${fallbackBase}:${occurrence}`;
    const previousSource = baseKey ? projectionState.sourceHashByKey.get(baseKey) : undefined;
    if (
      baseKey &&
      previousSource &&
      previousSource === hashToolResultText(getToolResultTextBlocks(message))
    ) {
      // A later duplicate must move the original projection, not make its sent bytes disappear.
      const replacement = projectionState.replacements.get(baseKey);
      if (replacement) {
        projectionState.replacements.set(key, replacement);
        projectionState.replacements.delete(baseKey);
      }
      projectionState.sourceHashByKey.set(key, previousSource);
      projectionState.sourceHashByKey.delete(baseKey);
      if (projectionState.frozen.delete(baseKey)) {
        projectionState.frozen.add(key);
      }
    }
    return key;
  });
}

/** Keep canonical transcript identity when provider replay rewrites tool-call ids. */
export function bindToolResultPromptProjectionKeys(
  messages: AgentMessage[],
  projectionState: ToolResultPromptProjectionState,
): AgentMessage[] {
  const keys = getToolResultProjectionKeys(messages, projectionState);
  return messages.map((message, index) => {
    const key = keys[index];
    return key ? Object.assign({}, message, { [TOOL_RESULT_PROJECTION_KEY]: key }) : message;
  });
}

export function getToolResultTextBlocks(message: AgentMessage): string[] {
  if (message.role !== "toolResult") {
    return [];
  }
  const content = message.content;
  return Array.isArray(content)
    ? content.flatMap((block) =>
        isRecord(block) && block.type === "text"
          ? [typeof block.text === "string" ? block.text : ""]
          : [],
      )
    : [];
}

export function hashToolResultText(texts: string[]): string {
  // JSON framing preserves block boundaries and lone surrogates, including persisted fallback keys.
  return sha256Base64Url(JSON.stringify(texts));
}
