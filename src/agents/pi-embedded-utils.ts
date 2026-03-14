import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { extractTextFromChatContent } from "../shared/chat-content.js";
import { stripReasoningTagsFromText } from "../shared/text/reasoning-tags.js";
import { sanitizeUserFacingText } from "./pi-embedded-helpers.js";
import { formatToolDetail, resolveToolDisplay } from "./tool-display.js";

export function isAssistantMessage(msg: AgentMessage | undefined): msg is AssistantMessage {
  return msg?.role === "assistant";
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
 * Fix malformed XML from Qwen models that use <function=name> instead of <function name="name">.
 * Qwen3.5 8B sometimes generates non-standard XML attribute syntax that breaks parsing.
 * This normalizes:
 * - <function=xxx> → <function name="xxx">
 * - <parameter=xxx> → <parameter name="xxx">
 */
export function fixQwenMalformedXml(text: string): string {
  if (!text) {
    return text;
  }
  if (!/<(?:function|parameter)=/i.test(text)) {
    return text;
  }
  return text.replace(/<(function|parameter)=([^>\s]+)>/gi, '<$1 name="$2">');
}

/**
 * Strip <tool_call> and <tool_result> XML blocks from text content.
 * Some models (e.g. Qwen) embed tool calls as XML in text instead of using
 * native tool call structures. After parsing them in ollama-stream.ts,
 * any remaining raw XML should be stripped from display text.
 */
export function stripToolCallXml(text: string): string {
  if (!text) {
    return text;
  }
  if (!/<tool_(?:call|result)/i.test(text)) {
    return text;
  }
  let cleaned = text.replace(/<tool_call\b[^>]*>[\s\S]*?<\/tool_call>/gi, "");
  cleaned = cleaned.replace(/<tool_result\b[^>]*>[\s\S]*?<\/tool_result>/gi, "");
  cleaned = cleaned.replace(/<\/?tool_(?:call|result)\b[^>]*>/gi, "");
  return cleaned;
}

/**
 * Parse Qwen-style embedded tool calls from text content.
 * Qwen3.5 8B sometimes embeds tool calls as XML in text instead of using
 * the native Ollama tool_calls format. This extracts them into structured objects.
 *
 * Input format:
 *   <tool_call>
 *   <function=read>
 *   <parameter=path>/some/file.py</parameter>
 *   </function>
 *   </tool_call>
 */
export function parseQwenEmbeddedToolCalls(text: string): {
  remainingText: string;
  toolCalls: { name: string; arguments: Record<string, unknown> }[];
} {
  if (!text || !/<tool_call>/i.test(text)) {
    return { remainingText: text, toolCalls: [] };
  }

  // Normalize Qwen's malformed XML before parsing
  const normalized = fixQwenMalformedXml(text);

  const tryParseValue = (raw: string): unknown => {
    const trimmed = raw.trim();
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  };

  const toolCalls: { name: string; arguments: Record<string, unknown> }[] = [];
  const blockRe = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
  let match: RegExpExecArray | null;
  while ((match = blockRe.exec(normalized)) !== null) {
    const block = match[1];
    const funcMatch = /<function[=\s](?:name=")?([^>"'\s]+)"?>/i.exec(block);
    if (!funcMatch) continue;
    const funcName = funcMatch[1];
    const args: Record<string, unknown> = {};
    const paramRe = /<parameter[=\s](?:name=")?([^>"'\s]+)"?>\s*([\s\S]*?)\s*<\/parameter>/gi;
    let paramMatch: RegExpExecArray | null;
    while ((paramMatch = paramRe.exec(block)) !== null) {
      args[paramMatch[1]] = tryParseValue(paramMatch[2]);
    }
    toolCalls.push({ name: funcName, arguments: args });
  }

  if (toolCalls.length === 0) {
    return { remainingText: text, toolCalls: [] };
  }

  const remainingText = text.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "").trim();
  return { remainingText, toolCalls };
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
        if (ch === '"') { inString = true; continue; }
        if (ch === "{" || ch === "[") { depth += 1; continue; }
        if (ch === "}" || ch === "]") {
          depth -= 1;
          if (depth === 0) { return i + 1; }
        }
      }
      return null;
    }
    if (startChar === '"') {
      let escape = false;
      for (let i = index + 1; i < input.length; i += 1) {
        const ch = input[i];
        if (escape) { escape = false; continue; }
        if (ch === "\\") { escape = true; continue; }
        if (ch === '"') { return i + 1; }
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
      if (start < cursor) { continue; }
      result += input.slice(cursor, start);
      let index = start + match[0].length;
      while (index < input.length && (input[index] === " " || input[index] === "\t")) { index += 1; }
      if (input[index] === "\r") {
        index += 1;
        if (input[index] === "\n") { index += 1; }
      } else if (input[index] === "\n") {
        index += 1;
      }
      while (index < input.length && (input[index] === " " || input[index] === "\t")) { index += 1; }
      if (input.slice(index, index + 9).toLowerCase() === "arguments") {
        index += 9;
        if (input[index] === ":") { index += 1; }
        if (input[index] === " ") { index += 1; }
        const end = consumeJsonish(input, index, { allowLeadingNewlines: true });
        if (end !== null) { index = end; }
      }
      if (
        (input[index] === "\n" || input[index] === "\r") &&
        (result.endsWith("\n") || result.endsWith("\r") || result.length === 0)
      ) {
        if (input[index] === "\r") { index += 1; }
        if (input[index] === "\n") { index += 1; }
      }
      cursor = index;
    }
    result += input.slice(cursor);
    return result;
  };

  let cleaned = stripToolCalls(text);
  cleaned = cleaned.replace(/\[Tool Result for ID[^\]]*\]\n?[\s\S]*?(?=\n*\[Tool |\n*$)/gi, "");
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
          stripDowngradedToolCallText(
            stripModelSpecialTokens(
              stripMinimaxToolCallXml(
                stripToolCallXml(text)
              )
            )
          ),
        ).trim(),
      joinWith: "\n",
      normalizeText: (text) => text.trim(),
    }) ?? "";
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
    if (!value) { return; }
    blocks.push({ type: "text", text: value });
  };
  const pushThinking = (value: string) => {
    const cleaned = value.trim();
    if (!cleaned) { return; }
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
