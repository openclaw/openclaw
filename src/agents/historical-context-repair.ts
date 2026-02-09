import type { AssistantMessage } from "@mariozechner/pi-ai";

/**
 * Repair patch for "Historical context" tool-call leakage.
 *
 * Some models (e.g. during multi-model handoff) emit tool calls as plain text
 * in the format:
 *
 *   [Historical context: a different model called tool "NAME" with arguments: {
 *     …JSON…
 *   }. Do not mimic this format - use proper function calling.]
 *
 * This module:
 * 1. Promotes those patterns to proper `toolCall` content blocks.
 * 2. Wraps any free-form text *preceding* the marker as `thinking` blocks
 *    (equivalent to `<think>…</think>`).
 * 3. Provides a text-level strip function as a safety net for
 *    `extractAssistantText`.
 *
 * Kept in a standalone file to minimise churn on the rest of the codebase.
 */

// ── constants ───────────────────────────────────────────────

const HC_PREFIX = "[Historical context:";
const HC_TOOL_INTRO = 'a different model called tool "';
const HC_ARGS_INTRO = '" with arguments:';
const HC_SUFFIX = ". Do not mimic this format - use proper function calling.]";

// ── JSON consumer ───────────────────────────────────────────

/**
 * Consume a balanced JSON object/array starting at `start`, skipping leading
 * whitespace. Returns end index (exclusive) or `null`.
 */
function consumeBalancedJson(input: string, start: number): number | null {
  let i = start;
  while (i < input.length && /\s/.test(input[i])) {
    i++;
  }
  if (i >= input.length) {
    return null;
  }

  const open = input[i];
  if (open !== "{" && open !== "[") {
    return null;
  }

  let depth = 0;
  let inStr = false;
  let esc = false;

  for (; i < input.length; i++) {
    const ch = input[i];
    if (inStr) {
      if (esc) {
        esc = false;
        continue;
      }
      if (ch === "\\") {
        esc = true;
        continue;
      }
      if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === "{" || ch === "[") {
      depth++;
      continue;
    }
    if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) {
        return i + 1;
      }
    }
  }
  return null;
}

// ── single-pattern parser ───────────────────────────────────

type ParsedHC = {
  toolName: string;
  args: Record<string, unknown>;
  /** Exclusive end index in the source string. */
  end: number;
};

function parseOneHC(text: string, markerStart: number): ParsedHC | null {
  let cur = markerStart + HC_PREFIX.length;

  // skip whitespace after prefix
  while (cur < text.length && /\s/.test(text[cur])) {
    cur++;
  }

  // expect: a different model called tool "
  if (!text.startsWith(HC_TOOL_INTRO, cur)) {
    return null;
  }
  cur += HC_TOOL_INTRO.length;

  // extract tool name (up to the closing ")
  const nameEnd = text.indexOf('"', cur);
  if (nameEnd < 0) {
    return null;
  }
  const toolName = text.slice(cur, nameEnd);
  cur = nameEnd; // sitting on the closing "

  // expect: " with arguments:
  if (!text.startsWith(HC_ARGS_INTRO, cur)) {
    return null;
  }
  cur += HC_ARGS_INTRO.length;

  // consume balanced JSON
  const jsonEnd = consumeBalancedJson(text, cur);
  if (jsonEnd === null) {
    return null;
  }

  // locate the first non-whitespace char of the JSON for slicing
  let jsonStart = cur;
  while (jsonStart < text.length && /\s/.test(text[jsonStart])) {
    jsonStart++;
  }

  let args: Record<string, unknown>;
  try {
    args = JSON.parse(text.slice(jsonStart, jsonEnd)) as Record<string, unknown>;
  } catch {
    return null;
  }
  cur = jsonEnd;

  // look for the standard suffix close-by (allow small gap for whitespace)
  const tail = text.slice(cur);
  const suffixIdx = tail.indexOf(HC_SUFFIX);
  if (suffixIdx >= 0 && suffixIdx < 20) {
    cur += suffixIdx + HC_SUFFIX.length;
  } else {
    // fallback: find any closing ']' within a reasonable range
    const bracketIdx = tail.indexOf("]");
    if (bracketIdx >= 0 && bracketIdx < 200) {
      cur += bracketIdx + 1;
    }
  }

  return { toolName, args, end: cur };
}

// ── helpers ─────────────────────────────────────────────────

/** Strip `"""` fences that some models use around text blocks. */
function stripTripleQuotes(text: string): string {
  return text.replace(/^"""\s*/gm, "").replace(/\s*"""$/gm, "");
}

// ── public: block promotion ─────────────────────────────────

/**
 * Scan assistant-message text blocks for `[Historical context: …]` patterns
 * and promote each occurrence to a proper `toolCall` content block.
 *
 * Free-form text that precedes a marker is treated as the model's internal
 * reasoning and promoted to a `thinking` block (equivalent to wrapping it in
 * `<think>…</think>`).
 *
 * Mutates `message.content` in place — same contract as
 * {@link import("./pi-embedded-utils.js").promoteThinkingTagsToBlocks}.
 */
export function promoteHistoricalContextToBlocks(message: AssistantMessage): void {
  if (!Array.isArray(message.content)) {
    return;
  }

  // Quick-exit when no text block contains the marker.
  const hasMarker = message.content.some((b) => {
    if (!b || typeof b !== "object") {
      return false;
    }
    const r = b as unknown as Record<string, unknown>;
    return r.type === "text" && typeof r.text === "string" && String(r.text).includes(HC_PREFIX);
  });
  if (!hasMarker) {
    return;
  }

  const next: AssistantMessage["content"] = [];
  let changed = false;

  for (const block of message.content) {
    if (
      !block ||
      typeof block !== "object" ||
      (block as unknown as Record<string, unknown>).type !== "text"
    ) {
      next.push(block);
      continue;
    }

    const rawText = (block as unknown as Record<string, unknown>).text;
    const src = typeof rawText === "string" ? rawText : "";
    if (!src.includes(HC_PREFIX)) {
      next.push(block);
      continue;
    }

    changed = true;
    let cursor = 0;

    while (cursor < src.length) {
      const idx = src.indexOf(HC_PREFIX, cursor);
      if (idx < 0) {
        // remaining text after last pattern
        const tail = stripTripleQuotes(src.slice(cursor)).trim();
        if (tail) {
          next.push({ type: "text", text: tail } as never);
        }
        break;
      }

      // text before the marker → thinking (model's internal reasoning)
      const before = stripTripleQuotes(src.slice(cursor, idx)).trim();
      if (before) {
        next.push({ type: "thinking", thinking: before } as never);
      }

      const parsed = parseOneHC(src, idx);
      if (parsed) {
        // Emit as a thinking block rather than a toolCall block.
        // Historical tool calls from another model must not become real toolCall
        // content blocks — those require matching toolResult messages, and the
        // session tool-result guard would synthesise error results for them.
        const argsJson = JSON.stringify(parsed.args, null, 2);
        next.push({
          type: "thinking",
          thinking: `[Historical tool call: ${parsed.toolName}]\n${argsJson}`,
        } as never);
        cursor = parsed.end;
        // skip trailing whitespace / blank lines
        while (cursor < src.length && /\s/.test(src[cursor])) {
          cursor++;
        }
      } else {
        // un-parseable — keep as-is and step past the prefix
        cursor = idx + HC_PREFIX.length;
      }
    }
  }

  if (changed) {
    message.content = next;
  }
}

// ── public: text stripping (safety net) ─────────────────────

/**
 * Strip `[Historical context: …]` blocks from plain text.
 * Companion to {@link promoteHistoricalContextToBlocks} — use in
 * `extractAssistantText` as a safety net alongside
 * `stripMinimaxToolCallXml` / `stripDowngradedToolCallText`.
 */
export function stripHistoricalContextText(text: string): string {
  if (!text || !text.includes(HC_PREFIX)) {
    return text;
  }

  let result = "";
  let cursor = 0;

  while (cursor < text.length) {
    const idx = text.indexOf(HC_PREFIX, cursor);
    if (idx < 0) {
      result += text.slice(cursor);
      break;
    }
    result += text.slice(cursor, idx);

    const parsed = parseOneHC(text, idx);
    if (parsed) {
      cursor = parsed.end;
      // collapse consecutive line breaks left behind
      while (cursor < text.length && (text[cursor] === "\n" || text[cursor] === "\r")) {
        cursor++;
      }
    } else {
      result += HC_PREFIX;
      cursor = idx + HC_PREFIX.length;
    }
  }

  return result.trim();
}
