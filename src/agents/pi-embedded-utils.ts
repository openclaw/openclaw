import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { findCodeRegions } from "../shared/text/code-regions.js";
import { stripReasoningTagsFromText } from "../shared/text/reasoning-tags.js";
import { sanitizeUserFacingText } from "./pi-embedded-helpers.js";
import { formatToolDetail, resolveToolDisplay } from "./tool-display.js";
import { normalizeToolName } from "./tool-policy-shared.js";

export function isAssistantMessage(msg: AgentMessage | undefined): msg is AssistantMessage {
  return msg?.role === "assistant";
}

// Zero-width space used to mark blocks that should be joined without a newline.
const INLINE_GLUE = "\u200B";

// Share these robust regex patterns across the module.
const MINIMAX_INVOKE_RE = /<invoke\b([^>]*?)(?:\/>|>([\s\S]*?)<\/invoke>)/gi;
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

/**
 * Assistant text extraction with smart block joining.
 */
export function extractAssistantText(msg: AssistantMessage): string {
  const sanitize = (text: string) =>
    stripDowngradedToolCallText(stripModelSpecialTokens(stripMinimaxToolCallXml(text)));

  let result = "";
  if (Array.isArray(msg.content)) {
    for (let i = 0; i < msg.content.length; i++) {
      const block = msg.content[i];
      if (block?.type === "text") {
        const text = sanitize(block.text);
        if (!text) {
          continue;
        }

        if (result) {
          // If the last block ends with INLINE_GLUE, join without newline.
          // Otherwise, join with \n to satisfy block-sensitive directives like MEDIA:.
          if (result.endsWith(INLINE_GLUE)) {
            result = result.slice(0, -INLINE_GLUE.length) + text;
          } else {
            result += "\n" + text;
          }
        } else {
          result = text;
        }
      }
    }
  } else if (typeof msg.content === "string") {
    result = sanitize(msg.content);
  }

  const cleaned = stripThinkingTagsFromText(result).split(INLINE_GLUE).join("");
  const errorContext = msg.stopReason === "error";
  return sanitizeUserFacingText(cleaned.trim(), { errorContext });
}

/**
 * Assistant thinking extraction with smart block joining.
 * Codex P2: Preserve inline spacing when rejoining split reasoning blocks.
 */
export function extractAssistantThinking(msg: AssistantMessage): string {
  if (!Array.isArray(msg.content)) {
    return "";
  }
  let result = "";
  const blocks = msg.content
    .map((block) => {
      if (!block || typeof block !== "object") {
        return null;
      }
      const record = block as unknown as Record<string, unknown>;
      if (record.type === "thinking" && typeof record.thinking === "string") {
        return record.thinking;
      }
      return null;
    })
    .filter((t): t is string => t !== null);

  for (let i = 0; i < blocks.length; i++) {
    const text = blocks[i];
    if (result) {
      if (result.endsWith(INLINE_GLUE)) {
        result = result.slice(0, -INLINE_GLUE.length) + text;
      } else {
        result += "\n" + text;
      }
    } else {
      result = text;
    }
  }

  return result.split(INLINE_GLUE).join("").trim();
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

/**
 * Identifies regions of text that are within Markdown code blocks or inline code.
 */
function getMarkdownMaskRegions(
  text: string,
): Array<{ start: number; end: number; masked: boolean }> {
  const regions: Array<{ start: number; end: number; masked: boolean }> = [];
  const codeRegions = findCodeRegions(text);
  let lastIdx = 0;
  for (const region of codeRegions) {
    if (region.start > lastIdx) {
      regions.push({ start: lastIdx, end: region.start, masked: false });
    }
    regions.push({ start: region.start, end: region.end, masked: true });
    lastIdx = region.end;
  }
  if (lastIdx < text.length) {
    regions.push({ start: lastIdx, end: text.length, masked: false });
  }
  return regions;
}

/**
 * Split text by thinking tags, avoiding tags inside Markdown code blocks.
 * Marks inline splits with INLINE_GLUE.
 *
 * Codex P2: Don't treat literal inline <think> examples as hidden reasoning.
 * We now require the tag to be at the start of a block or preceded by whitespace.
 */
export function splitThinkingTaggedText(text: string): ThinkTaggedSplitBlock[] | null {
  const openRe = /<\s*(?:think(?:ing)?|thought|antthinking)\s*>/i;
  const closeRe = /<\s*\/\s*(?:think(?:ing)?|thought|antthinking)\s*>/i;

  if (!openRe.test(text)) {
    return null;
  }
  if (!closeRe.test(text)) {
    return null;
  }

  const regions = getMarkdownMaskRegions(text);
  const scanRe = /<\s*(\/?)\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi;
  let inThinking = false;
  let cursor = 0;
  let thinkingStart = 0;
  const blocks: ThinkTaggedSplitBlock[] = [];

  for (const region of regions) {
    if (region.masked) {
      continue;
    }
    const subText = text.slice(region.start, region.end);
    for (const match of subText.matchAll(scanRe)) {
      const index = (match.index ?? 0) + region.start;
      const isClose = Boolean(match[1]?.includes("/"));

      if (!inThinking && !isClose) {
        // Codex P2 Guard: Only promote if at the start of a line (or start of text).
        const precedingText = text.slice(0, index);
        const lastLineBreak = precedingText.lastIndexOf("\n");
        const prefixOnLine =
          lastLineBreak === -1 ? precedingText : precedingText.slice(lastLineBreak + 1);
        const isLegitTag = !prefixOnLine.trim();
        if (!isLegitTag) {
          continue;
        }

        let prose = text.slice(cursor, index);
        // If this is a mid-line split, mark it.
        if (prose && !prose.endsWith("\n") && !prose.endsWith("\r")) {
          prose += INLINE_GLUE;
        }
        if (prose) {
          blocks.push({ type: "text", text: prose });
        }
        thinkingStart = index + match[0].length;
        inThinking = true;
        continue;
      }

      if (inThinking && isClose) {
        let thoughts = text.slice(thinkingStart, index);
        // Also mark inline splits within thinking blocks
        if (thoughts && !thoughts.endsWith("\n") && !thoughts.endsWith("\r")) {
          thoughts += INLINE_GLUE;
        }
        blocks.push({ type: "thinking", thinking: thoughts.trim() });
        cursor = index + match[0].length;
        inThinking = false;
      }
    }
  }

  if (inThinking) {
    return null;
  } // Must be strictly closed
  if (cursor < text.length) {
    blocks.push({ type: "text", text: text.slice(cursor) });
  }

  return blocks.length > 0 ? blocks : null;
}

/**
 * Collapses adjacent text blocks that were split but belong
 * to the same line/sentence, preventing artificial newlines in extraction.
 */
function mergeInlineTextBlocks(blocks: AssistantMessage["content"]): AssistantMessage["content"] {
  const next: AssistantMessage["content"] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") {
      next.push(block);
      continue;
    }
    const last = next[next.length - 1];
    if (last?.type === "text" && block?.type === "text") {
      // Logic: If the preceding block ends with INLINE_GLUE, merge them.
      if (last.text.endsWith(INLINE_GLUE)) {
        last.text += block.text;
        continue;
      }
    }
    next.push(block);
  }
  return next;
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
    message.content = mergeInlineTextBlocks(next);
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
    message.content = mergeInlineTextBlocks(next);
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

  // Find the last closing tag that appears AFTER the last opening tag.
  const lastClose = closeMatches.toReversed().find((m) => (m.index ?? -1) > (lastOpen.index ?? -1));
  if (lastClose) {
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
 * Basic XML entity unescaper. Handles &amp; last to avoid double-decoding.
 */
export function unescapeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (match, dec) => {
      const code = parseInt(dec, 10);
      if (code >= 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          /* Fallback */
        }
      }
      return match;
    })
    .replace(/&#x([0-9a-f]+);/gi, (match, hex) => {
      const code = parseInt(hex, 16);
      if (code >= 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          /* Fallback */
        }
      }
      return match;
    })
    .replace(/&amp;/g, "&"); // Handle &amp; last to avoid double-decoding
}

/**
 * Parse a raw XML parameter value into its appropriate type.
 */
export function parseXmlParameterValue(value: string): unknown {
  if (value === undefined) {
    return {};
  } // For self-closing invoke with no params

  const unescaped = unescapeXmlEntities(value);
  const trimmed = unescaped.trim();

  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
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
export function splitMinimaxToolCalls(
  text: string,
  options?: { globalCounter?: { val: number } },
): MinimaxToolCallSplitBlock[] | null {
  if (!text || !/minimax:tool_call/i.test(text)) {
    return null;
  }
  const { globalCounter = { val: 0 } } = options ?? {};

  const regions = getMarkdownMaskRegions(text);
  const wrapperRe = /<minimax:tool_call>([\s\S]*?)<\/minimax:tool_call>|<\/minimax:tool_call>/gi;

  const blocks: MinimaxToolCallSplitBlock[] = [];
  let cursor = 0;
  let hasToolCall = false;

  for (const region of regions) {
    if (region.masked) {
      continue;
    }
    const subText = text.slice(region.start, region.end);
    for (const match of subText.matchAll(wrapperRe)) {
      const index = (match.index ?? 0) + region.start;
      const [fullMatch, innerContent] = match;

      // Push preceding text prose (this is safely outside any wrapper)
      if (index > cursor) {
        let prose = text.slice(cursor, index);
        // If this is a mid-line split, mark it.
        if (prose && !prose.endsWith("\n") && !prose.endsWith("\r")) {
          prose += INLINE_GLUE;
        }
        if (prose) {
          blocks.push({ type: "text", text: prose });
        }
      }

      const isExplicitWrapper = innerContent !== undefined;

      // Case B: Malformed closing tag fallback.
      if (!isExplicitWrapper && (blocks.length > 0 || /<invoke\b/i.test(text.slice(0, index)))) {
        // Search the most recent text block, or search entire preceding text if blocks is empty
        let searchSource = "";
        let targetBlock: MinimaxToolCallSplitBlock | undefined = undefined;

        if (blocks.length > 0) {
          targetBlock = blocks[blocks.length - 1];
          if (targetBlock.type === "text") {
            searchSource = targetBlock.text;
          }
        } else {
          searchSource = text.slice(0, index);
        }

        if (searchSource && /<invoke\b/i.test(searchSource)) {
          const searchOffset = targetBlock ? cursor : 0;
          const matchedInvokes = Array.from(searchSource.matchAll(MINIMAX_INVOKE_RE)).filter(
            (match) => {
              const mStart = (match.index ?? 0) + searchOffset;
              const mEnd = mStart + match[0].length;
              // Codex P1: Exclude backticked/fenced samples from recovery.
              return !regions.some((r) => r.masked && mStart < r.end && mEnd > r.start);
            },
          );

          if (matchedInvokes.length > 0) {
            const lastInvoke = matchedInvokes[matchedInvokes.length - 1];
            const lastInvokeText = lastInvoke[0];
            const lastInvokeEnd = (lastInvoke.index ?? 0) + lastInvokeText.length;
            const trailingProse = searchSource.slice(lastInvokeEnd);

            // Only reclaim if the trailing prose is empty (ignore space/glue)
            const cleanedTrailing = trailingProse.split(INLINE_GLUE).join("").trim();
            if (!cleanedTrailing) {
              let lastProcessedIdx = 0;
              if (targetBlock) {
                blocks.pop();
              } // Remove the block to replace it

              for (const iMatch of matchedInvokes) {
                const iIndex = iMatch.index ?? 0;
                const [iFullMatch, attributes, invokeBody] = iMatch;

                if (iIndex > lastProcessedIdx) {
                  const subProse = searchSource.slice(lastProcessedIdx, iIndex);
                  if (subProse) {
                    blocks.push({ type: "text", text: subProse });
                  }
                }

                const nameMatch = /\bname=["']([^"']+)["']/i.exec(attributes);
                const toolName = nameMatch ? nameMatch[1] : undefined;
                if (toolName) {
                  const args: Record<string, unknown> = {};
                  if (invokeBody) {
                    for (const pMatch of invokeBody.matchAll(MINIMAX_PARAM_RE)) {
                      const [, pName, pValue] = pMatch;
                      args[pName] = parseXmlParameterValue(pValue);
                    }
                  }
                  blocks.push({
                    type: "toolCall",
                    id: `mc_mm_fb_${globalCounter.val++}_${normalizeToolName(toolName)}`,
                    name: normalizeToolName(toolName),
                    arguments: args,
                  });
                  hasToolCall = true;
                }
                lastProcessedIdx = iIndex + iFullMatch.length;
              }

              if (lastProcessedIdx < searchSource.length) {
                const finalSubProse = searchSource.slice(lastProcessedIdx);
                if (finalSubProse) {
                  blocks.push({ type: "text", text: finalSubProse });
                }
              }
            }
          }
        }
      }

      // Case A: Explicit <minimax:tool_call> inner content.
      if (isExplicitWrapper && innerContent) {
        let innerCursor = 0;
        for (const iMatch of innerContent.matchAll(MINIMAX_INVOKE_RE)) {
          const iIndex = iMatch.index ?? 0;
          const [iFullMatch, attributes, invokeBody] = iMatch;

          if (iIndex > innerCursor) {
            const innerProse = innerContent.slice(innerCursor, iIndex);
            if (innerProse) {
              blocks.push({ type: "text", text: innerProse });
            }
          }

          const nameMatch = /\bname=["']([^"']+)["']/i.exec(attributes);
          const toolName = nameMatch ? nameMatch[1] : undefined;
          if (toolName) {
            const args: Record<string, unknown> = {};
            if (invokeBody) {
              for (const pMatch of invokeBody.matchAll(MINIMAX_PARAM_RE)) {
                const [, pName, pValue] = pMatch;
                args[pName] = parseXmlParameterValue(pValue);
              }
            }
            blocks.push({
              type: "toolCall",
              id: `mc_mm_${globalCounter.val++}_${normalizeToolName(toolName)}`,
              name: normalizeToolName(toolName),
              arguments: args,
            });
            hasToolCall = true;
          }
          innerCursor = iIndex + iFullMatch.length;
        }
        if (innerCursor < innerContent.length) {
          const remainingInnerProse = innerContent.slice(innerCursor);
          if (remainingInnerProse) {
            let p = remainingInnerProse;
            if (!p.endsWith("\n") && !p.endsWith("\r")) {
              p += INLINE_GLUE;
            }
            blocks.push({ type: "text", text: p });
          }
        }
      }

      cursor = index + fullMatch.length;
    }
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
  const globalCounter = { val: 0 };

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

    const split = splitMinimaxToolCalls(messageContent, { globalCounter });
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
    message.content = mergeInlineTextBlocks(next);
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

    const split = splitMinimaxToolCalls(textValue, { globalCounter });
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
    message.content = mergeInlineTextBlocks(next);
  }
}
