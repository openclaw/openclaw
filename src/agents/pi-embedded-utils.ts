import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { extractTextFromChatContent } from "../shared/chat-content.js";
import { stripReasoningTagsFromText } from "../shared/text/reasoning-tags.js";
import { sanitizeUserFacingText } from "./pi-embedded-helpers.js";
import { formatToolDetail, resolveToolDisplay } from "./tool-display.js";

export function isAssistantMessage(msg: AgentMessage | undefined): msg is AssistantMessage {
  return msg?.role === "assistant";
}

export interface ParsedMinimaxToolCall {
  name: string;
  input: Record<string, string>;
  id: string;
}

let minimaxToolCallCounter = 0;

/** Reset the tool-call counter (for test isolation). */
export function resetMinimaxToolCallCounter(): void {
  minimaxToolCallCounter = 0;
}

const XML_ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

function decodeXmlEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => XML_ENTITY_MAP[entity] ?? entity);
}

/**
 * Parse MiniMax XML tool invocations from text content.
 *
 * MiniMax M2.5 embeds tool calls as XML instead of structured `toolUse` blocks:
 * ```xml
 * <minimax:tool_call>
 * <invoke name="some_tool">
 * <parameter name="param1">value1</parameter>
 * </invoke>
 * </minimax:tool_call>
 * ```
 *
 * Returns an array of parsed tool calls. Returns empty array when the text
 * contains no minimax tool call markers or no parseable invocations.
 */
export function parseMinimaxToolCallXml(text: string): ParsedMinimaxToolCall[] {
  if (!text || (!/minimax:tool_call/i.test(text) && !/<invoke\s/i.test(text))) {
    return [];
  }

  const toolCalls: ParsedMinimaxToolCall[] = [];

  // Track character ranges covered by <minimax:tool_call> segments so bare
  // <invoke> blocks inside them are not double-counted.
  const coveredRanges: [number, number][] = [];

  // First: parse <invoke> blocks within <minimax:tool_call>...</minimax:tool_call> segments.
  const segmentRe = /<minimax:tool_call>([\s\S]*?)<\/minimax:tool_call>/gi;

  for (const segment of text.matchAll(segmentRe)) {
    coveredRanges.push([segment.index, segment.index + segment[0].length]);
    const segmentText = segment[1];
    const invokeRe = /<invoke\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/invoke>/gi;

    for (const match of segmentText.matchAll(invokeRe)) {
      const name = match[1];
      const body = match[2];
      const input: Record<string, string> = {};

      const paramRe = /<parameter\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/parameter>/gi;
      for (const paramMatch of body.matchAll(paramRe)) {
        input[paramMatch[1]] = decodeXmlEntities(paramMatch[2]);
      }

      minimaxToolCallCounter += 1;
      toolCalls.push({
        name,
        input,
        id: `toolu_minimax_${minimaxToolCallCounter}`,
      });
    }
  }

  // Second: parse bare <invoke> blocks not inside any <minimax:tool_call> segment.
  // MiniMax can send <invoke> without the wrapping <minimax:tool_call> tag.
  const bareInvokeRe = /<invoke\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/invoke>/gi;
  for (const match of text.matchAll(bareInvokeRe)) {
    const matchStart = match.index;
    const matchEnd = matchStart + match[0].length;
    if (coveredRanges.some(([s, e]) => matchStart >= s && matchEnd <= e)) {
      continue;
    }

    const name = match[1];
    const body = match[2];
    const input: Record<string, string> = {};

    const paramRe = /<parameter\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/parameter>/gi;
    for (const paramMatch of body.matchAll(paramRe)) {
      input[paramMatch[1]] = decodeXmlEntities(paramMatch[2]);
    }

    minimaxToolCallCounter += 1;
    toolCalls.push({
      name,
      input,
      id: `toolu_minimax_${minimaxToolCallCounter}`,
    });
  }

  return toolCalls;
}

/**
 * Transform MiniMax XML tool invocations in text content blocks into
 * structured `toolUse` content blocks on the assistant message.
 *
 * Follows the same in-place mutation pattern as {@link promoteThinkingTagsToBlocks}.
 * Must be called before {@link extractAssistantText} so the tool calls are
 * available as structured blocks and the XML is removed from displayed text.
 *
 * Falls back gracefully: if parsing yields no tool calls the text block is
 * left untouched and the existing strip-only path in extractAssistantText
 * will clean it up.
 */
export function promoteMinimaxToolCallsToBlocks(message: AssistantMessage): void {
  if (!Array.isArray(message.content)) {
    return;
  }

  const next: AssistantMessage["content"] = [];
  let changed = false;

  for (const block of message.content) {
    if (!block || typeof block !== "object" || !("type" in block)) {
      next.push(block);
      continue;
    }
    if (block.type !== "text") {
      next.push(block);
      continue;
    }
    const text: string = (block as { text?: string }).text ?? "";
    if (!text || (!/minimax:tool_call/i.test(text) && !/<invoke\s/i.test(text))) {
      next.push(block);
      continue;
    }

    const toolCalls = parseMinimaxToolCallXml(text);
    if (toolCalls.length === 0) {
      // No parseable invocations — keep the block as-is; the strip function
      // inside extractAssistantText will still clean stray tags.
      next.push(block);
      continue;
    }

    changed = true;

    // Walk through tool-call regions: either <minimax:tool_call>...</minimax:tool_call>
    // segments or bare <invoke>...</invoke> blocks.
    const regionRe =
      /<minimax:tool_call>[\s\S]*?<\/minimax:tool_call>|<invoke\s+name=["'][^"']+["'][^>]*>[\s\S]*?<\/invoke>/gi;
    let cursor = 0;
    let tcIdx = 0;

    for (const regionMatch of text.matchAll(regionRe)) {
      const matchStart = regionMatch.index;
      // Strip stray minimax wrapper tags from interleaved prose.
      const prose = text
        .slice(cursor, matchStart)
        .replace(/<\/?minimax:tool_call>/gi, "")
        .trim();
      if (prose) {
        next.push({ type: "text", text: prose });
      }

      // Count invoke blocks within this region to advance tcIdx
      const invokeReInner = /<invoke\s+name=["'][^"']+["'][^>]*>[\s\S]*?<\/invoke>/gi;
      for (const _inv of regionMatch[0].matchAll(invokeReInner)) {
        if (tcIdx < toolCalls.length) {
          const tc = toolCalls[tcIdx];
          next.push({
            type: "toolUse",
            id: tc.id,
            name: tc.name,
            input: tc.input,
          } as unknown as (typeof next)[number]);
          tcIdx += 1;
        }
      }

      cursor = matchStart + regionMatch[0].length;
    }

    // Trailing prose after the last region.
    const trailing = text
      .slice(cursor)
      .replace(/<\/?minimax:tool_call>/gi, "")
      .trim();
    if (trailing) {
      next.push({ type: "text", text: trailing });
    }
  }

  if (!changed) {
    return;
  }
  message.content = next;
}

/**
 * Strip malformed Minimax tool invocations that leak into text content.
 * Minimax sometimes embeds tool calls as XML in text blocks instead of
 * proper structured tool calls. This removes:
 * - <invoke name="...">...</invoke> blocks
 * - </minimax:tool_call> closing tags
 */
export function stripMinimaxToolCallXml(text: string): string {
  if (!text) {
    return text;
  }
  if (!/minimax:tool_call/i.test(text)) {
    return text;
  }

  // Remove <invoke ...>...</invoke> blocks (non-greedy to handle multiple).
  let cleaned = text.replace(/<invoke\b[^>]*>[\s\S]*?<\/invoke>/gi, "");

  // Remove stray minimax tool tags.
  cleaned = cleaned.replace(/<\/?minimax:tool_call>/gi, "");

  return cleaned;
}

/**
 * Strip model control tokens leaked into assistant text output.
 *
 * Models like GLM-5 and DeepSeek sometimes emit internal delimiter tokens
 * (e.g. `<|assistant|>`, `<|tool_call_result_begin|>`, `<｜begin▁of▁sentence｜>`)
 * in their responses. These use the universal `<|...|>` convention (ASCII or
 * full-width pipe variants) and should never reach end users.
 *
 * This is a provider bug — no upstream fix tracked yet.
 * Remove this function when upstream providers stop leaking tokens.
 * @see https://github.com/openclaw/openclaw/issues/40020
 */
// Match both ASCII pipe <|...|> and full-width pipe <｜...｜> (U+FF5C) variants.
const MODEL_SPECIAL_TOKEN_RE = /<[|｜][^|｜]*[|｜]>/g;

export function stripModelSpecialTokens(text: string): string {
  if (!text) {
    return text;
  }
  if (!MODEL_SPECIAL_TOKEN_RE.test(text)) {
    return text;
  }
  MODEL_SPECIAL_TOKEN_RE.lastIndex = 0;
  return text.replace(MODEL_SPECIAL_TOKEN_RE, " ").replace(/  +/g, " ").trim();
}

/**
 * Strip downgraded tool call text representations that leak into text content.
 * When replaying history to Gemini, tool calls without `thought_signature` are
 * downgraded to text blocks like `[Tool Call: name (ID: ...)]`. These should
 * not be shown to users.
 */
export function stripDowngradedToolCallText(text: string): string {
  if (!text) {
    return text;
  }
  if (!/\[Tool (?:Call|Result)/i.test(text) && !/\[Historical context/i.test(text)) {
    return text;
  }

  const consumeJsonish = (
    input: string,
    start: number,
    options?: { allowLeadingNewlines?: boolean },
  ): number | null => {
    const { allowLeadingNewlines = false } = options ?? {};
    let index = start;
    while (index < input.length) {
      const ch = input[index];
      if (ch === " " || ch === "\t") {
        index += 1;
        continue;
      }
      if (allowLeadingNewlines && (ch === "\n" || ch === "\r")) {
        index += 1;
        continue;
      }
      break;
    }
    if (index >= input.length) {
      return null;
    }

    const startChar = input[index];
    if (startChar === "{" || startChar === "[") {
      let depth = 0;
      let inString = false;
      let escape = false;
      for (let i = index; i < input.length; i += 1) {
        const ch = input[i];
        if (inString) {
          if (escape) {
            escape = false;
          } else if (ch === "\\") {
            escape = true;
          } else if (ch === '"') {
            inString = false;
          }
          continue;
        }
        if (ch === '"') {
          inString = true;
          continue;
        }
        if (ch === "{" || ch === "[") {
          depth += 1;
          continue;
        }
        if (ch === "}" || ch === "]") {
          depth -= 1;
          if (depth === 0) {
            return i + 1;
          }
        }
      }
      return null;
    }

    if (startChar === '"') {
      let escape = false;
      for (let i = index + 1; i < input.length; i += 1) {
        const ch = input[i];
        if (escape) {
          escape = false;
          continue;
        }
        if (ch === "\\") {
          escape = true;
          continue;
        }
        if (ch === '"') {
          return i + 1;
        }
      }
      return null;
    }

    let end = index;
    while (end < input.length && input[end] !== "\n" && input[end] !== "\r") {
      end += 1;
    }
    return end;
  };

  const stripToolCalls = (input: string): string => {
    const markerRe = /\[Tool Call:[^\]]*\]/gi;
    let result = "";
    let cursor = 0;
    for (const match of input.matchAll(markerRe)) {
      const start = match.index ?? 0;
      if (start < cursor) {
        continue;
      }
      result += input.slice(cursor, start);
      let index = start + match[0].length;
      while (index < input.length && (input[index] === " " || input[index] === "\t")) {
        index += 1;
      }
      if (input[index] === "\r") {
        index += 1;
        if (input[index] === "\n") {
          index += 1;
        }
      } else if (input[index] === "\n") {
        index += 1;
      }
      while (index < input.length && (input[index] === " " || input[index] === "\t")) {
        index += 1;
      }
      if (input.slice(index, index + 9).toLowerCase() === "arguments") {
        index += 9;
        if (input[index] === ":") {
          index += 1;
        }
        if (input[index] === " ") {
          index += 1;
        }
        const end = consumeJsonish(input, index, { allowLeadingNewlines: true });
        if (end !== null) {
          index = end;
        }
      }
      if (
        (input[index] === "\n" || input[index] === "\r") &&
        (result.endsWith("\n") || result.endsWith("\r") || result.length === 0)
      ) {
        if (input[index] === "\r") {
          index += 1;
        }
        if (input[index] === "\n") {
          index += 1;
        }
      }
      cursor = index;
    }
    result += input.slice(cursor);
    return result;
  };

  // Remove [Tool Call: name (ID: ...)] blocks and their Arguments.
  let cleaned = stripToolCalls(text);

  // Remove [Tool Result for ID ...] blocks and their content.
  cleaned = cleaned.replace(/\[Tool Result for ID[^\]]*\]\n?[\s\S]*?(?=\n*\[Tool |\n*$)/gi, "");

  // Remove [Historical context: ...] markers (self-contained within brackets).
  cleaned = cleaned.replace(/\[Historical context:[^\]]*\]\n?/gi, "");

  return cleaned.trim();
}

/**
 * Strip thinking tags and their content from text.
 * This is a safety net for cases where the model outputs <think> tags
 * that slip through other filtering mechanisms.
 */
export function stripThinkingTagsFromText(text: string): string {
  return stripReasoningTagsFromText(text, { mode: "strict", trim: "both" });
}

export function extractAssistantText(msg: AssistantMessage): string {
  const extracted =
    extractTextFromChatContent(msg.content, {
      sanitizeText: (text) =>
        stripThinkingTagsFromText(
          stripDowngradedToolCallText(stripModelSpecialTokens(stripMinimaxToolCallXml(text))),
        ).trim(),
      joinWith: "\n",
      normalizeText: (text) => text.trim(),
    }) ?? "";
  // Only apply keyword-based error rewrites when the assistant message is actually an error.
  // Otherwise normal prose that *mentions* errors (e.g. "context overflow") can get clobbered.
  // Gate on stopReason only — a non-error response with an errorMessage set (e.g. from a
  // background tool failure) should not have its content rewritten (#13935).
  const errorContext = msg.stopReason === "error";
  return sanitizeUserFacingText(extracted, { errorContext });
}

export function extractAssistantThinking(msg: AssistantMessage): string {
  if (!Array.isArray(msg.content)) {
    return "";
  }
  const blocks = msg.content
    .map((block) => {
      if (!block || typeof block !== "object") {
        return "";
      }
      const record = block as unknown as Record<string, unknown>;
      if (record.type === "thinking" && typeof record.thinking === "string") {
        return record.thinking.trim();
      }
      return "";
    })
    .filter(Boolean);
  return blocks.join("\n").trim();
}

export function formatReasoningMessage(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }
  // Show reasoning in italics (cursive) for markdown-friendly surfaces (Discord, etc.).
  // Keep the plain "Reasoning:" prefix so existing parsing/detection keeps working.
  // Note: Underscore markdown cannot span multiple lines on Telegram, so we wrap
  // each non-empty line separately.
  const italicLines = trimmed
    .split("\n")
    .map((line) => (line ? `_${line}_` : line))
    .join("\n");
  return `Reasoning:\n${italicLines}`;
}

type ThinkTaggedSplitBlock =
  | { type: "thinking"; thinking: string }
  | { type: "text"; text: string };

export function splitThinkingTaggedText(text: string): ThinkTaggedSplitBlock[] | null {
  const trimmedStart = text.trimStart();
  // Avoid false positives: only treat it as structured thinking when it begins
  // with a think tag (common for local/OpenAI-compat providers that emulate
  // reasoning blocks via tags).
  if (!trimmedStart.startsWith("<")) {
    return null;
  }
  const openRe = /<\s*(?:think(?:ing)?|thought|antthinking)\s*>/i;
  const closeRe = /<\s*\/\s*(?:think(?:ing)?|thought|antthinking)\s*>/i;
  if (!openRe.test(trimmedStart)) {
    return null;
  }
  if (!closeRe.test(text)) {
    return null;
  }

  const scanRe = /<\s*(\/?)\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi;
  let inThinking = false;
  let cursor = 0;
  let thinkingStart = 0;
  const blocks: ThinkTaggedSplitBlock[] = [];

  const pushText = (value: string) => {
    if (!value) {
      return;
    }
    blocks.push({ type: "text", text: value });
  };
  const pushThinking = (value: string) => {
    const cleaned = value.trim();
    if (!cleaned) {
      return;
    }
    blocks.push({ type: "thinking", thinking: cleaned });
  };

  for (const match of text.matchAll(scanRe)) {
    const index = match.index ?? 0;
    const isClose = Boolean(match[1]?.includes("/"));

    if (!inThinking && !isClose) {
      pushText(text.slice(cursor, index));
      thinkingStart = index + match[0].length;
      inThinking = true;
      continue;
    }

    if (inThinking && isClose) {
      pushThinking(text.slice(thinkingStart, index));
      cursor = index + match[0].length;
      inThinking = false;
    }
  }

  if (inThinking) {
    return null;
  }
  pushText(text.slice(cursor));

  const hasThinking = blocks.some((b) => b.type === "thinking");
  if (!hasThinking) {
    return null;
  }
  return blocks;
}

export function promoteThinkingTagsToBlocks(message: AssistantMessage): void {
  if (!Array.isArray(message.content)) {
    return;
  }
  const hasThinkingBlock = message.content.some(
    (block) => block && typeof block === "object" && block.type === "thinking",
  );
  if (hasThinkingBlock) {
    return;
  }

  const next: AssistantMessage["content"] = [];
  let changed = false;

  for (const block of message.content) {
    if (!block || typeof block !== "object" || !("type" in block)) {
      next.push(block);
      continue;
    }
    if (block.type !== "text") {
      next.push(block);
      continue;
    }
    const split = splitThinkingTaggedText(block.text);
    if (!split) {
      next.push(block);
      continue;
    }
    changed = true;
    for (const part of split) {
      if (part.type === "thinking") {
        next.push({ type: "thinking", thinking: part.thinking });
      } else if (part.type === "text") {
        const cleaned = part.text.trimStart();
        if (cleaned) {
          next.push({ type: "text", text: cleaned });
        }
      }
    }
  }

  if (!changed) {
    return;
  }
  message.content = next;
}

export function extractThinkingFromTaggedText(text: string): string {
  if (!text) {
    return "";
  }
  const scanRe = /<\s*(\/?)\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi;
  let result = "";
  let lastIndex = 0;
  let inThinking = false;
  for (const match of text.matchAll(scanRe)) {
    const idx = match.index ?? 0;
    if (inThinking) {
      result += text.slice(lastIndex, idx);
    }
    const isClose = match[1] === "/";
    inThinking = !isClose;
    lastIndex = idx + match[0].length;
  }
  return result.trim();
}

export function extractThinkingFromTaggedStream(text: string): string {
  if (!text) {
    return "";
  }
  const closed = extractThinkingFromTaggedText(text);
  if (closed) {
    return closed;
  }

  const openRe = /<\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi;
  const closeRe = /<\s*\/\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi;
  const openMatches = [...text.matchAll(openRe)];
  if (openMatches.length === 0) {
    return "";
  }
  const closeMatches = [...text.matchAll(closeRe)];
  const lastOpen = openMatches[openMatches.length - 1];
  const lastClose = closeMatches[closeMatches.length - 1];
  if (lastClose && (lastClose.index ?? -1) > (lastOpen.index ?? -1)) {
    return closed;
  }
  const start = (lastOpen.index ?? 0) + lastOpen[0].length;
  return text.slice(start).trim();
}

export function inferToolMetaFromArgs(toolName: string, args: unknown): string | undefined {
  const display = resolveToolDisplay({ name: toolName, args });
  return formatToolDetail(display);
}
