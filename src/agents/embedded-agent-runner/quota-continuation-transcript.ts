import { asOptionalRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import {
  canonicalizePersistedUserMessageMedia,
  readPersistedMediaFacts,
  readRuntimePromptMediaFacts,
} from "../../media/media-facts.js";
import type { AgentMessage } from "../runtime/index.js";
import {
  readPersistedMediaImageLayout,
  readPersistedImageBlockFactIndexes,
} from "./run/prompt-image-metadata.js";

/** This first handoff contract does not authorize transferring historical media. */
export function hasTextOnlyHistoryContent(message: AgentMessage): boolean {
  const record = asRecord(message);
  const role = record?.role;
  if (!record || (role !== "user" && role !== "assistant" && role !== "toolResult")) {
    return false;
  }
  try {
    const persisted =
      role === "user" ? canonicalizePersistedUserMessageMedia(record).message : record;
    // Text captions can hydrate into images/video on the destination. Consult the
    // same media-fact owner as normal replay, including legacy persisted envelopes.
    if (
      readRuntimePromptMediaFacts(record)?.length ||
      readPersistedMediaFacts(persisted)?.length ||
      readPersistedMediaImageLayout(message) ||
      readPersistedImageBlockFactIndexes(message)?.length
    ) {
      return false;
    }
  } catch {
    return false;
  }
  const content: unknown = record.content;
  if (typeof content === "string") {
    return true;
  }
  if (!Array.isArray(content)) {
    return false;
  }
  return content.every((part: unknown) => {
    const block = asRecord(part);
    if (block?.type === "text") {
      return typeof block.text === "string";
    }
    if (role === "assistant" && block?.type === "thinking") {
      return typeof block.thinking === "string";
    }
    if (role === "assistant" && block?.type === "toolCall") {
      return (
        typeof block.id === "string" &&
        typeof block.name === "string" &&
        Boolean(asRecord(block.arguments))
      );
    }
    return (
      role === "toolResult" &&
      block?.type === "toolResult" &&
      typeof block.text === "string" &&
      block.content === block.text
    );
  });
}

/** Validate the entire current turn, not just its last tool batch. */
export function isSettledQuotaTranscript(messages: readonly AgentMessage[]): boolean {
  const rawMessages: unknown = messages;
  if (
    !Array.isArray(rawMessages) ||
    messages.length < 3 ||
    messages.length > 256 ||
    messages[0]?.role !== "user"
  ) {
    return false;
  }
  const calls = new Map<string, string>();
  const results = new Set<string>();
  let bytes = 0;
  for (const [index, message] of messages.entries()) {
    if (!message || typeof message !== "object" || !hasTextOnlyHistoryContent(message)) {
      return false;
    }
    try {
      bytes += Buffer.byteLength(JSON.stringify(message));
    } catch {
      return false;
    }
    if (bytes > 512 * 1024) {
      return false;
    }
    if (message.role === "user") {
      if (
        index !== 0 ||
        (typeof message.content !== "string" && !Array.isArray(message.content)) ||
        (Array.isArray(message.content) && message.content.some((part) => part.type !== "text"))
      ) {
        return false;
      }
    } else if (message.role === "assistant") {
      if (calls.size !== results.size || !Array.isArray(message.content)) {
        return false;
      }
      for (const part of message.content) {
        if (!part || typeof part !== "object") {
          return false;
        }
        if (part.type !== "toolCall") {
          continue;
        }
        if (
          typeof part.id !== "string" ||
          !part.id.trim() ||
          typeof part.name !== "string" ||
          !part.name.trim() ||
          calls.has(part.id)
        ) {
          return false;
        }
        calls.set(part.id, part.name);
      }
    } else if (message.role === "toolResult") {
      if (
        typeof message.toolCallId !== "string" ||
        !message.toolCallId.trim() ||
        typeof message.toolName !== "string" ||
        !message.toolName.trim() ||
        calls.get(message.toolCallId) !== message.toolName ||
        results.has(message.toolCallId) ||
        asRecord(message)?.isError !== false ||
        !Array.isArray(message.content) ||
        message.content.some((part) => {
          const block = asRecord(part);
          if (block?.type === "text" && typeof block.text === "string") {
            return false;
          }
          // The persisted native mirror uses a text-bearing toolResult block.
          // Validate its complete call identity instead of treating it as new work.
          return !(
            block?.type === "toolResult" &&
            typeof block.text === "string" &&
            block.content === block.text &&
            ["id", "toolCallId", "toolUseId", "tool_use_id"].every(
              (key) => block[key] === message.toolCallId,
            ) &&
            ["name", "toolName"].every((key) => block[key] === message.toolName)
          );
        })
      ) {
        return false;
      }
      results.add(message.toolCallId);
    } else {
      return false;
    }
  }
  return calls.size > 0 && calls.size === results.size;
}
