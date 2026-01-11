import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type {
  ImageContent,
  TextContent,
  ToolResultMessage,
} from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import type { EffectiveContextPruningSettings } from "./settings.js";
import { makeToolPrunablePredicate } from "./tools.js";

const CHARS_PER_TOKEN_ESTIMATE = 4;
// We currently skip pruning tool results that contain images. Still, we count them (approx.) so
// we start trimming prunable tool results earlier when image-heavy context is consuming the window.
const IMAGE_CHAR_ESTIMATE = 8_000;

function asText(text: string): TextContent {
  return { type: "text", text };
}

function collectTextSegments(
  content: ReadonlyArray<TextContent | ImageContent>,
): string[] {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") parts.push(block.text);
  }
  return parts;
}

function estimateJoinedTextLength(parts: string[]): number {
  if (parts.length === 0) return 0;
  let len = 0;
  for (const p of parts) len += p.length;
  // Joined with "\n" separators between blocks.
  len += Math.max(0, parts.length - 1);
  return len;
}

function takeHeadFromJoinedText(parts: string[], maxChars: number): string {
  if (maxChars <= 0 || parts.length === 0) return "";
  let remaining = maxChars;
  let out = "";
  for (let i = 0; i < parts.length && remaining > 0; i++) {
    if (i > 0) {
      out += "\n";
      remaining -= 1;
      if (remaining <= 0) break;
    }
    const p = parts[i];
    if (p.length <= remaining) {
      out += p;
      remaining -= p.length;
    } else {
      out += p.slice(0, remaining);
      remaining = 0;
    }
  }
  return out;
}

function takeTailFromJoinedText(parts: string[], maxChars: number): string {
  if (maxChars <= 0 || parts.length === 0) return "";
  let remaining = maxChars;
  const out: string[] = [];
  for (let i = parts.length - 1; i >= 0 && remaining > 0; i--) {
    const p = parts[i];
    if (p.length <= remaining) {
      out.push(p);
      remaining -= p.length;
    } else {
      out.push(p.slice(p.length - remaining));
      remaining = 0;
      break;
    }
    if (remaining > 0 && i > 0) {
      out.push("\n");
      remaining -= 1;
    }
  }
  out.reverse();
  return out.join("");
}

function hasImageBlocks(
  content: ReadonlyArray<TextContent | ImageContent>,
): boolean {
  for (const block of content) {
    if (block.type === "image") return true;
  }
  return false;
}

function estimateMessageChars(message: AgentMessage): number {
  if (message.role === "user") {
    const content = message.content;
    if (typeof content === "string") return content.length;
    let chars = 0;
    for (const b of content) {
      if (b.type === "text") chars += b.text.length;
      if (b.type === "image") chars += IMAGE_CHAR_ESTIMATE;
    }
    return chars;
  }

  if (message.role === "assistant") {
    let chars = 0;
    for (const b of message.content) {
      if (b.type === "text") chars += b.text.length;
      if (b.type === "thinking") chars += b.thinking.length;
      if (b.type === "toolCall") {
        try {
          chars += JSON.stringify(b.arguments ?? {}).length;
        } catch {
          chars += 128;
        }
      }
    }
    return chars;
  }

  if (message.role === "toolResult") {
    let chars = 0;
    for (const b of message.content) {
      if (b.type === "text") chars += b.text.length;
      if (b.type === "image") chars += IMAGE_CHAR_ESTIMATE;
    }
    return chars;
  }

  return 256;
}

function estimateContextChars(messages: AgentMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageChars(m), 0);
}

export { estimateMessageChars, estimateContextChars };

/**
 * Emergency circuit breaker: truncates session to last N messages when context is critically large.
 * This prevents auto-compaction deadlock when the summarization request itself exceeds the context window.
 *
 * @param messages - Current session messages
 * @param maxTokens - Maximum allowed tokens (e.g., 180,000 for a 200k model)
 * @returns Truncated messages with system message explaining the truncation
 */
export function emergencyTruncateMessages(params: {
  messages: AgentMessage[];
  maxTokens: number;
  keepLastMessages?: number; // Default: 5 user messages
}): AgentMessage[] {
  const { messages, maxTokens, keepLastMessages = 5 } = params;

  // Estimate current token count
  const currentChars = estimateContextChars(messages);
  const currentTokens = Math.ceil(currentChars / CHARS_PER_TOKEN_ESTIMATE);

  // If we're already under the limit, return as-is (no truncation needed)
  const needsTruncation = currentTokens > maxTokens;
  if (!needsTruncation) {
    return messages;
  }

  // Find the cutoff index: the first message OF the last N user messages
  let userMessageCount = 0;
  let keepFromIndex = 0; // Default to keeping everything

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) continue;

    if (msg.role === "user") {
      userMessageCount++;
      if (userMessageCount === keepLastMessages) {
        // Found the first user message in our keep range
        // Keep everything starting from this message
        keepFromIndex = i;
        break;
      }
    }
  }

  // Keep system and session header messages at the start
  const headerMessages: AgentMessage[] = [];
  let sessionHeaderIndex = -1;

  // Helper to check if a message looks like a session header (JSON with type: "session")
  function isSessionHeader(msg: AgentMessage): boolean {
    if (msg.role !== "user") return false;
    if (typeof msg.content === "string") {
      try {
        const parsed = JSON.parse(msg.content);
        return parsed.type === "session";
      } catch {
        return false;
      }
    }
    if (Array.isArray(msg.content) && msg.content.length > 0) {
      const block = msg.content[0];
      if (block.type === "text") {
        try {
          const parsed = JSON.parse(block.text);
          return parsed.type === "session";
        } catch {
          return false;
        }
      }
    }
    return false;
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;

    if (msg.role === "system") {
      headerMessages.push(msg);
    } else if (msg.role === "user" && sessionHeaderIndex === -1) {
      // Check if this looks like a session header (JSON with type: "session")
      if (isSessionHeader(msg)) {
        headerMessages.push(msg);
        sessionHeaderIndex = i;
      } else {
        // Not a session header, stop here
        break;
      }
    } else {
      break;
    }
  }

  // Build the truncated message list
  const truncatedMessages: AgentMessage[] = [
    ...headerMessages,
  ];

  // Add a summary message explaining the truncation
  const summaryText = `[EMERGENCY CONTEXT TRUNCATION] The session history exceeded ${currentTokens} tokens (limit: ${maxTokens}). To prevent a permanent failure state, older messages have been removed. Only the last ${keepLastMessages} user messages and their associated results are kept. Use /compact to create a proper summary.`;

  truncatedMessages.push({
    role: "assistant",
    content: [{ type: "text", text: summaryText }],
  } as unknown as AgentMessage);

  // Add the remaining messages from the cutoff point
  if (keepFromIndex > 0 && keepFromIndex < messages.length) {
    truncatedMessages.push(...messages.slice(keepFromIndex));
  }

  return truncatedMessages;
}

function findAssistantCutoffIndex(
  messages: AgentMessage[],
  keepLastAssistants: number,
): number | null {
  // keepLastAssistants <= 0 => everything is potentially prunable.
  if (keepLastAssistants <= 0) return messages.length;

  let remaining = keepLastAssistants;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== "assistant") continue;
    remaining--;
    if (remaining === 0) return i;
  }

  // Not enough assistant messages to establish a protected tail.
  return null;
}

function findFirstUserIndex(messages: AgentMessage[]): number | null {
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === "user") return i;
  }
  return null;
}

function softTrimToolResultMessage(params: {
  msg: ToolResultMessage;
  settings: EffectiveContextPruningSettings;
}): ToolResultMessage | null {
  const { msg, settings } = params;
  // Ignore image tool results for now: these are often directly relevant and hard to partially prune safely.
  if (hasImageBlocks(msg.content)) return null;

  const parts = collectTextSegments(msg.content);
  const rawLen = estimateJoinedTextLength(parts);
  if (rawLen <= settings.softTrim.maxChars) return null;

  const headChars = Math.max(0, settings.softTrim.headChars);
  const tailChars = Math.max(0, settings.softTrim.tailChars);
  if (headChars + tailChars >= rawLen) return null;

  const head = takeHeadFromJoinedText(parts, headChars);
  const tail = takeTailFromJoinedText(parts, tailChars);
  const trimmed = `${head}
...
${tail}`;

  const note = `

[Tool result trimmed: kept first ${headChars} chars and last ${tailChars} chars of ${rawLen} chars.]`;

  return { ...msg, content: [asText(trimmed + note)] };
}

export function pruneContextMessages(params: {
  messages: AgentMessage[];
  settings: EffectiveContextPruningSettings;
  ctx: Pick<ExtensionContext, "model">;
  isToolPrunable?: (toolName: string) => boolean;
  contextWindowTokensOverride?: number;
}): AgentMessage[] {
  const { messages, settings, ctx } = params;
  const contextWindowTokens =
    typeof params.contextWindowTokensOverride === "number" &&
    Number.isFinite(params.contextWindowTokensOverride) &&
    params.contextWindowTokensOverride > 0
      ? params.contextWindowTokensOverride
      : ctx.model?.contextWindow;
  if (!contextWindowTokens || contextWindowTokens <= 0) return messages;

  const charWindow = contextWindowTokens * CHARS_PER_TOKEN_ESTIMATE;
  if (charWindow <= 0) return messages;

  const cutoffIndex = findAssistantCutoffIndex(
    messages,
    settings.keepLastAssistants,
  );
  if (cutoffIndex === null) return messages;

  // Bootstrap safety: never prune anything before the first user message. This protects initial
  // "identity" reads (SOUL.md, USER.md, etc.) which typically happen before the first inbound user
  // message exists in the session transcript.
  const firstUserIndex = findFirstUserIndex(messages);
  const pruneStartIndex =
    firstUserIndex === null ? messages.length : firstUserIndex;

  const isToolPrunable =
    params.isToolPrunable ?? makeToolPrunablePredicate(settings.tools);

  if (settings.mode === "aggressive") {
    let next: AgentMessage[] | null = null;

    for (let i = pruneStartIndex; i < cutoffIndex; i++) {
      const msg = messages[i];
      if (!msg || msg.role !== "toolResult") continue;
      if (!isToolPrunable(msg.toolName)) continue;
      if (hasImageBlocks(msg.content)) {
        continue;
      }

      const alreadyCleared =
        msg.content.length === 1 &&
        msg.content[0]?.type === "text" &&
        msg.content[0].text === settings.hardClear.placeholder;
      if (alreadyCleared) continue;

      const cleared: ToolResultMessage = {
        ...msg,
        content: [asText(settings.hardClear.placeholder)],
      };
      if (!next) next = messages.slice();
      next[i] = cleared as unknown as AgentMessage;
    }

    return next ?? messages;
  }

  const totalCharsBefore = estimateContextChars(messages);
  let totalChars = totalCharsBefore;
  let ratio = totalChars / charWindow;
  if (ratio < settings.softTrimRatio) {
    return messages;
  }

  const prunableToolIndexes: number[] = [];
  let next: AgentMessage[] | null = null;

  for (let i = pruneStartIndex; i < cutoffIndex; i++) {
    const msg = messages[i];
    if (!msg || msg.role !== "toolResult") continue;
    if (!isToolPrunable(msg.toolName)) continue;
    if (hasImageBlocks(msg.content)) {
      continue;
    }
    prunableToolIndexes.push(i);

    const updated = softTrimToolResultMessage({
      msg: msg as unknown as ToolResultMessage,
      settings,
    });
    if (!updated) continue;

    const beforeChars = estimateMessageChars(msg);
    const afterChars = estimateMessageChars(updated as unknown as AgentMessage);
    totalChars += afterChars - beforeChars;
    if (!next) next = messages.slice();
    next[i] = updated as unknown as AgentMessage;
  }

  const outputAfterSoftTrim = next ?? messages;
  ratio = totalChars / charWindow;
  if (ratio < settings.hardClearRatio) {
    return outputAfterSoftTrim;
  }
  if (!settings.hardClear.enabled) {
    return outputAfterSoftTrim;
  }

  let prunableToolChars = 0;
  for (const i of prunableToolIndexes) {
    const msg = outputAfterSoftTrim[i];
    if (!msg || msg.role !== "toolResult") continue;
    prunableToolChars += estimateMessageChars(msg);
  }
  if (prunableToolChars < settings.minPrunableToolChars) {
    return outputAfterSoftTrim;
  }

  for (const i of prunableToolIndexes) {
    if (ratio < settings.hardClearRatio) break;
    const msg = (next ?? messages)[i];
    if (!msg || msg.role !== "toolResult") continue;

    const beforeChars = estimateMessageChars(msg);
    const cleared: ToolResultMessage = {
      ...msg,
      content: [asText(settings.hardClear.placeholder)],
    };
    if (!next) next = messages.slice();
    next[i] = cleared as unknown as AgentMessage;
    const afterChars = estimateMessageChars(cleared as unknown as AgentMessage);
    totalChars += afterChars - beforeChars;
    ratio = totalChars / charWindow;
  }

  return next ?? messages;
}
