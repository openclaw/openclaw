import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { extractTextFromChatContent } from "../shared/chat-content.js";
import { stripReasoningTagsFromText } from "../shared/text/reasoning-tags.js";
import { sanitizeUserFacingText } from "./pi-embedded-helpers.js";
import { formatToolDetail, resolveToolDisplay } from "./tool-display.js";
import { normalizeToolName } from "./tool-policy-shared.js";

export function isAssistantMessage(msg: AgentMessage | undefined): msg is AssistantMessage {
  return msg?.role === "assistant";
}

// Share these robust regex patterns across the module.
const MINIMAX_INVOKE_RE = /<invoke\b([^>]*?)>([\s\S]*?)<\/invoke>/gi;
const MINIMAX_MARKER_RE = /<\/?minimax:tool_call>/gi;
const MINIMAX_PARAM_RE = /<parameter\b[^>]*name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/parameter>/gi;

/**
 * Strip malformed Minimax tool invocations that leak into text content.
 */
export function stripMinimaxToolCallXml(text: string): string {
  if (!text || !/minimax:tool_call/i.test(text)) {
    return text;
  }

  let cleaned = text.replace(MINIMAX_INVOKE_RE, "");
  cleaned = cleaned.replace(MINIMAX_MARKER_RE, "");

  return cleaned;
}

/**
 * Strip model control tokens leaked into assistant text output.
 */
const MODEL_SPECIAL_TOKEN_RE = /<[|｜][^|｜]*[|｜]>/g;

export function stripModelSpecialTokens(text: string): string {
  if (!text) {
    return text;
  }
  if (!MODEL_SPECIAL_TOKEN_RE.test(text)) {
    return text;
  }
  MODEL_SPECIAL_TOKEN_RE.lastIndex = 0;
  return text.replace(MODEL_SPECIAL_TOKEN_RE, " ").trim();
}

/**
 * Strip downgraded tool call text representations.
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

  let cleaned = stripToolCalls(text);
  cleaned = cleaned.replace(/\[Tool Result for ID[^\]]*\]\n?[\s\S]*?(?=\n*\[Tool |\n*$)/gi, "");
  cleaned = cleaned.replace(/\[Historical context:[^\]]*\]\n?/gi, "");

  return cleaned.trim();
}

/**
 * Strip thinking tags and their content from text.
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

  for (const match of text.matchAll(scanRe)) {
    const index = match.index ?? 0;
    const isClose = Boolean(match[1]?.includes("/"));

    if (!inThinking && !isClose) {
      const prose = text.slice(cursor, index);
      if (prose) {
        blocks.push({ type: "text", text: prose });
      }
      thinkingStart = index + match[0].length;
      inThinking = true;
      continue;
    }

    if (inThinking && isClose) {
      blocks.push({ type: "thinking", thinking: text.slice(thinkingStart, index).trim() });
      cursor = index + match[0].length;
      inThinking = false;
    }
  }

  if (inThinking) {
    return null;
  }
  if (cursor < text.length) {
    blocks.push({ type: "text", text: text.slice(cursor) });
  }

  return blocks;
}

export function promoteThinkingTagsToBlocks(message: AssistantMessage): void {
  if (!message) {
    return;
  }

  const originalContent = message.content;

  // Handle string-form assistant content
  if (typeof originalContent === "string") {
    const split = splitThinkingTaggedText(originalContent);
    if (!split) {
      return;
    }
    const next: AssistantMessage["content"] = [];
    for (const part of split) {
      if (part.type === "thinking") {
        next.push({ type: "thinking", thinking: part.thinking });
      } else {
        next.push({ type: "text", text: part.text });
      }
    }
    message.content = next;
    return;
  }

  if (!Array.isArray(originalContent)) {
    return;
  }
  const hasThinkingBlock = originalContent.some(
    (block) => block && typeof block === "object" && block.type === "thinking",
  );
  if (hasThinkingBlock) {
    return;
  }

  const next: AssistantMessage["content"] = [];
  let changed = false;

  for (const block of originalContent) {
    if (block?.type !== "text") {
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
      } else {
        next.push(part);
      }
    }
  }

  if (changed) {
    message.content = next;
  }
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
  const lastClose = closeMatches[lastOpen.index ? openMatches.length - 1 : 0]; // safety
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

/**
 * Basic XML entity unescaper for common and numeric entities.
 */
export function unescapeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
}

/**
 * Parse a raw XML parameter value into its appropriate type.
 */
export function parseXmlParameterValue(value: string): unknown {
  const unescaped = unescapeXmlEntities(value);
  const trimmed = unescaped.trim();

  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }

  // Parse numeric scalars (integers or floats).
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const num = Number(trimmed);
    if (!isNaN(num)) {
      return num;
    }
  }

  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // Fallback
    }
  }

  return unescaped;
}

type MinimaxToolCallSplitBlock =
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
  | { type: "text"; text: string };

/**
 * Split text content into text blocks and toolCall blocks by parsing
 * MiniMax-specific <minimax:tool_call> XML structures.
 */
export function splitMinimaxToolCalls(text: string): MinimaxToolCallSplitBlock[] | null {
  if (!text || !/minimax:tool_call/i.test(text)) {
    return null;
  }

  // Find all MiniMax wrapper tags to determine valid promotion ranges.
  const wrapperRe = /<minimax:tool_call>([\s\S]*?)<\/minimax:tool_call>|<\/minimax:tool_call>/gi;

  const blocks: MinimaxToolCallSplitBlock[] = [];
  let cursor = 0;
  let hasToolCall = false;

  for (const match of text.matchAll(wrapperRe)) {
    const index = match.index ?? 0;
    const [fullMatch, innerContent] = match;

    // Push preceding text prose (this is safely outside any wrapper)
    if (index > cursor) {
      const prose = text.slice(cursor, index);
      if (prose) {
        blocks.push({ type: "text", text: prose });
      }
    }

    // Determine the content to parse for <invoke> tags.
    const contentToParse = innerContent !== undefined ? innerContent : text.slice(cursor, index);

    // Parse the inner content, extracting <invoke> blocks AND keeping prose in between.
    let innerCursor = 0;
    for (const iMatch of contentToParse.matchAll(MINIMAX_INVOKE_RE)) {
      const iIndex = iMatch.index ?? 0;
      const [iFullMatch, attributes, invokeBody] = iMatch;

      // Preserve prose before this <invoke>
      if (iIndex > innerCursor) {
        const innerProse = contentToParse.slice(innerCursor, iIndex);
        if (innerProse) {
          blocks.push({ type: "text", text: innerProse });
        }
      }

      const nameMatch = /\bname=["']([^"']+)["']/i.exec(attributes);
      const toolName = nameMatch ? nameMatch[1] : undefined;

      if (toolName) {
        const args: Record<string, unknown> = {};
        for (const pMatch of invokeBody.matchAll(MINIMAX_PARAM_RE)) {
          const [, pName, pValue] = pMatch;
          args[pName] = parseXmlParameterValue(pValue);
        }

        blocks.push({
          type: "toolCall",
          id: `mc_${Math.random().toString(36).slice(2, 11)}`,
          name: normalizeToolName(toolName),
          arguments: args,
        });
        hasToolCall = true;
      }

      innerCursor = iIndex + iFullMatch.length;
    }

    // Preserve prose after the last <invoke> inside the wrapper
    if (innerCursor < contentToParse.length) {
      const remainingInnerProse = contentToParse.slice(innerCursor);
      if (remainingInnerProse) {
        blocks.push({ type: "text", text: remainingInnerProse });
      }
    }

    cursor = index + fullMatch.length;
  }

  if (!hasToolCall) {
    return null;
  }
  if (cursor < text.length) {
    blocks.push({ type: "text", text: text.slice(cursor) });
  }

  return blocks;
}

/**
 * Scan assistant message content for MiniMax-specific XML tool calls.
 */
export function promoteMinimaxToolCallsToBlocks(message: AssistantMessage): void {
  if (!message) {
    return;
  }

  const messageContent: unknown = message.content;

  // Handle string-form assistant content by converting it to a block array first.
  if (typeof messageContent === "string") {
    if (!messageContent.toLowerCase().includes("minimax:tool_call")) {
      return;
    }

    // IMPORTANT: First promote thinking tags while it's still a single string.
    // This handles cases where XML is nested inside <think> tags.
    promoteThinkingTagsToBlocks(message);

    // If it was promoted to blocks, we continue with the array-based logic below.
    // If it's still a string (e.g. no think tags), we split it manually here.
    if (typeof message.content !== "string") {
      promoteMinimaxToolCallsToBlocks(message);
      return;
    }

    const split = splitMinimaxToolCalls(messageContent);
    if (!split) {
      return;
    }
    const next: AssistantMessage["content"] = [];
    for (const part of split) {
      if (part.type === "toolCall") {
        next.push({
          type: "toolCall",
          id: part.id,
          name: part.name,
          arguments: part.arguments,
        } as unknown as AssistantMessage["content"][number]);
      } else {
        next.push({ type: "text", text: part.text });
      }
    }
    message.content = next;
    return;
  }

  if (!Array.isArray(messageContent)) {
    return;
  }

  const next: AssistantMessage["content"] = [];
  let changed = false;

  for (const block of messageContent) {
    if (!block || typeof block !== "object") {
      next.push(block);
      continue;
    }

    const type = block.type as string;
    // Handle both text and thinking blocks as sources for XML tool calls.
    const textValue =
      type === "text"
        ? (block as { text: string }).text
        : type === "thinking"
          ? (block as { thinking: string }).thinking
          : null;

    if (typeof textValue !== "string") {
      next.push(block);
      continue;
    }

    const split = splitMinimaxToolCalls(textValue);
    if (!split) {
      next.push(block);
      continue;
    }

    changed = true;
    for (const part of split) {
      if (part.type === "toolCall") {
        next.push({
          type: "toolCall",
          id: part.id,
          name: part.name,
          arguments: part.arguments,
        } as unknown as AssistantMessage["content"][number]);
      } else {
        if (type === "thinking") {
          next.push({
            type: "thinking",
            thinking: part.text,
          } as unknown as AssistantMessage["content"][number]);
        } else {
          next.push({ type: "text", text: part.text });
        }
      }
    }
  }

  if (changed) {
    message.content = next;
  }
}
