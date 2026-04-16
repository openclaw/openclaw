import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import {
  createHtmlEntityToolCallArgumentDecodingWrapper,
  decodeHtmlEntitiesInObject,
} from "../../../plugin-sdk/provider-stream-shared.js";
import { normalizeProviderId } from "../../model-selection.js";
import { log } from "../logger.js";

function isToolCallBlockType(type: unknown): boolean {
  return type === "toolCall" || type === "toolUse" || type === "functionCall";
}

type BalancedJsonPrefix = {
  json: string;
  startIndex: number;
};

const UNICODE_QUOTE_CHARS = new Set(["\u201C", "\u201D", "\u201E", "\u201F"]);

/**
 * Attempt to repair tool-call argument JSON by normalizing Unicode smart
 * quotes (U+201C/U+201D) used as JSON string delimiters down to ASCII `"`.
 *
 * Uses a character-level scan that tracks brace depth and string boundaries.
 * Only strings opened with a Unicode smart quote are considered for
 * normalisation — strings opened with ASCII `"` are left alone so that
 * content-level smart quotes inside them are preserved.
 * Only structural quotes — those at JSON key/value boundaries — are rewritten.
 */
function normalizeStructuralUnicodeQuotes(raw: string): string {
  let start = 0;
  while (start < raw.length) {
    const ch = raw[start];
    if (ch === "{" || ch === "[") {
      break;
    }
    start++;
  }
  if (start >= raw.length) {
    return raw;
  }

  const chars = [...raw];
  let depth = 0;
  let inString = false;
  let stringOpenerIsAscii = false;
  let escaped = false;
  const structuralQuoteIndices: number[] = [];

  for (let i = start; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === undefined) break;

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (stringOpenerIsAscii && ch === '"') {
        // ASCII-opened string: only ASCII `"` closes it.
        inString = false;
        structuralQuoteIndices.push(i);
      } else if (!stringOpenerIsAscii && UNICODE_QUOTE_CHARS.has(ch)) {
        // Unicode-opened string: only Unicode smart quotes close it.
        inString = false;
        structuralQuoteIndices.push(i);
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      stringOpenerIsAscii = true;
      structuralQuoteIndices.push(i);
      continue;
    }
    if (UNICODE_QUOTE_CHARS.has(ch)) {
      inString = true;
      stringOpenerIsAscii = false;
      structuralQuoteIndices.push(i);
      continue;
    }

    if (ch === "{" || ch === "[") {
      depth++;
      continue;
    }

    if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) break;
    }
  }

  if (structuralQuoteIndices.length === 0) {
    return raw;
  }

  for (const idx of structuralQuoteIndices) {
    if (UNICODE_QUOTE_CHARS.has(chars[idx])) {
      chars[idx] = '"';
    }
  }
  return chars.join("");
}

function extractBalancedJsonPrefix(raw: string): BalancedJsonPrefix | null {
  let start = 0;
  while (start < raw.length) {
    const char = raw[start];
    if (char === "{" || char === "[") {
      break;
    }
    start += 1;
  }
  if (start >= raw.length) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let stringOpenerIsAscii = false;
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
    const char = raw[i];
    if (char === undefined) {
      break;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (stringOpenerIsAscii && char === '"') {
        inString = false;
      } else if (!stringOpenerIsAscii && UNICODE_QUOTE_CHARS.has(char)) {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      stringOpenerIsAscii = true;
      continue;
    }
    if (UNICODE_QUOTE_CHARS.has(char)) {
      inString = true;
      stringOpenerIsAscii = false;
      continue;
    }
    if (char === "{" || char === "[") {
      depth += 1;
      continue;
    }
    if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) {
        return { json: raw.slice(start, i + 1), startIndex: start };
      }
    }
  }
  return null;
}

const MAX_TOOLCALL_REPAIR_BUFFER_CHARS = 64_000;
const MAX_TOOLCALL_REPAIR_LEADING_CHARS = 96;
const MAX_TOOLCALL_REPAIR_TRAILING_CHARS = 3;
const TOOLCALL_REPAIR_ALLOWED_LEADING_RE = /^[a-z0-9\s"'`.:/_\\-]+$/i;
const TOOLCALL_REPAIR_ALLOWED_TRAILING_RE = /^[^\s{}[\]":,\\]{1,3}$/;

function shouldAttemptMalformedToolCallRepair(partialJson: string, delta: string): boolean {
  if (/[}\]]/.test(delta)) {
    return true;
  }
  const trimmedDelta = delta.trim();
  return (
    trimmedDelta.length > 0 &&
    trimmedDelta.length <= MAX_TOOLCALL_REPAIR_TRAILING_CHARS &&
    /[}\]]/.test(partialJson)
  );
}

type ToolCallArgumentRepair = {
  args: Record<string, unknown>;
  kind: "preserved" | "repaired";
  leadingPrefix: string;
  trailingSuffix: string;
};

function isAllowedToolCallRepairLeadingPrefix(prefix: string): boolean {
  if (!prefix) {
    return true;
  }
  if (prefix.length > MAX_TOOLCALL_REPAIR_LEADING_CHARS) {
    return false;
  }
  if (!TOOLCALL_REPAIR_ALLOWED_LEADING_RE.test(prefix)) {
    return false;
  }
  return /^[.:'"`-]/.test(prefix) || /^(?:functions?|tools?)[._:/-]?/i.test(prefix);
}

function tryExtractUsableToolCallArguments(raw: string): ToolCallArgumentRepair | undefined {
  if (!raw.trim()) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? {
          args: parsed as Record<string, unknown>,
          kind: "preserved",
          leadingPrefix: "",
          trailingSuffix: "",
        }
      : undefined;
  } catch {
    // Try normalizing Unicode smart quotes used as JSON string delimiters
    // before falling back to balanced-prefix extraction.  Models such as
    // MiniMax occasionally emit Unicode left/right double quotation marks
    // (U+201C / U+201D) instead of ASCII `"` for JSON string delimiters,
    // which causes JSON.parse to fail.
    const normalized = normalizeStructuralUnicodeQuotes(raw);
    if (normalized !== raw) {
      try {
        const parsed = JSON.parse(normalized) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? {
              args: parsed as Record<string, unknown>,
              kind: "repaired",
              leadingPrefix: "",
              trailingSuffix: "",
            }
          : undefined;
      } catch {
        // Fall through to balanced-prefix extraction below
      }
    }
    // Prefer extracting from the original string so ASCII-delimited JSON with
    // Unicode content characters (e.g. CJK smart quotes) is not corrupted by
    // normalisation.  Fall back to the normalised version only when the raw
    // extraction yields nothing.
    const extracted =
      extractBalancedJsonPrefix(raw) ?? extractBalancedJsonPrefix(normalized);
    if (!extracted) {
      return undefined;
    }
    const leadingPrefix = raw.slice(0, extracted.startIndex).trim();
    if (!isAllowedToolCallRepairLeadingPrefix(leadingPrefix)) {
      return undefined;
    }
    const suffix = raw.slice(extracted.startIndex + extracted.json.length).trim();
    if (leadingPrefix.length === 0 && suffix.length === 0) {
      return undefined;
    }
    if (
      suffix.length > MAX_TOOLCALL_REPAIR_TRAILING_CHARS ||
      (suffix.length > 0 && !TOOLCALL_REPAIR_ALLOWED_TRAILING_RE.test(suffix))
    ) {
      return undefined;
    }
    // extracted.json is already a slice of either raw or normalized;
    // try parsing as-is first, then attempt normalisation if it fails.
    try {
      const parsed = JSON.parse(extracted.json) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? {
            args: parsed as Record<string, unknown>,
            kind: "repaired",
            leadingPrefix,
            trailingSuffix: suffix,
          }
        : undefined;
    } catch {
      // If the raw extraction failed to parse, try normalising Unicode quotes
      // in the extracted slice and re-attempt.
      const normalizedJson = normalizeStructuralUnicodeQuotes(extracted.json);
      if (normalizedJson !== extracted.json) {
        try {
          const parsed = JSON.parse(normalizedJson) as unknown;
          return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? {
                args: parsed as Record<string, unknown>,
                kind: "repaired",
                leadingPrefix,
                trailingSuffix: suffix,
              }
            : undefined;
        } catch {
          return undefined;
        }
      }
      return undefined;
    }
  }
}

function repairToolCallArgumentsInMessage(
  message: unknown,
  contentIndex: number,
  repairedArgs: Record<string, unknown>,
): void {
  if (!message || typeof message !== "object") {
    return;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return;
  }
  const block = content[contentIndex];
  if (!block || typeof block !== "object") {
    return;
  }
  const typedBlock = block as { type?: unknown; arguments?: unknown };
  if (!isToolCallBlockType(typedBlock.type)) {
    return;
  }
  typedBlock.arguments = repairedArgs;
}

function hasMeaningfulToolCallArgumentsInMessage(message: unknown, contentIndex: number): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return false;
  }
  const block = content[contentIndex];
  if (!block || typeof block !== "object") {
    return false;
  }
  const typedBlock = block as { type?: unknown; arguments?: unknown };
  if (!isToolCallBlockType(typedBlock.type)) {
    return false;
  }
  return (
    typedBlock.arguments !== null &&
    typeof typedBlock.arguments === "object" &&
    !Array.isArray(typedBlock.arguments) &&
    Object.keys(typedBlock.arguments as Record<string, unknown>).length > 0
  );
}

function clearToolCallArgumentsInMessage(message: unknown, contentIndex: number): void {
  if (!message || typeof message !== "object") {
    return;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return;
  }
  const block = content[contentIndex];
  if (!block || typeof block !== "object") {
    return;
  }
  const typedBlock = block as { type?: unknown; arguments?: unknown };
  if (!isToolCallBlockType(typedBlock.type)) {
    return;
  }
  typedBlock.arguments = {};
}

function repairMalformedToolCallArgumentsInMessage(
  message: unknown,
  repairedArgsByIndex: Map<number, Record<string, unknown>>,
): void {
  if (!message || typeof message !== "object") {
    return;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return;
  }
  for (const [index, repairedArgs] of repairedArgsByIndex.entries()) {
    repairToolCallArgumentsInMessage(message, index, repairedArgs);
  }
}

function wrapStreamRepairMalformedToolCallArguments(
  stream: ReturnType<typeof streamSimple>,
): ReturnType<typeof streamSimple> {
  const partialJsonByIndex = new Map<number, string>();
  const repairedArgsByIndex = new Map<number, Record<string, unknown>>();
  const hadPreexistingArgsByIndex = new Set<number>();
  const disabledIndices = new Set<number>();
  const loggedRepairIndices = new Set<number>();
  const originalResult = stream.result.bind(stream);
  stream.result = async () => {
    const message = await originalResult();
    repairMalformedToolCallArgumentsInMessage(message, repairedArgsByIndex);
    partialJsonByIndex.clear();
    repairedArgsByIndex.clear();
    hadPreexistingArgsByIndex.clear();
    disabledIndices.clear();
    loggedRepairIndices.clear();
    return message;
  };

  const originalAsyncIterator = stream[Symbol.asyncIterator].bind(stream);
  (stream as { [Symbol.asyncIterator]: typeof originalAsyncIterator })[Symbol.asyncIterator] =
    function () {
      const iterator = originalAsyncIterator();
      return {
        async next() {
          const result = await iterator.next();
          if (!result.done && result.value && typeof result.value === "object") {
            const event = result.value as {
              type?: unknown;
              contentIndex?: unknown;
              delta?: unknown;
              partial?: unknown;
              message?: unknown;
              toolCall?: unknown;
            };
            if (
              typeof event.contentIndex === "number" &&
              Number.isInteger(event.contentIndex) &&
              event.type === "toolcall_delta" &&
              typeof event.delta === "string"
            ) {
              if (disabledIndices.has(event.contentIndex)) {
                return result;
              }
              const nextPartialJson =
                (partialJsonByIndex.get(event.contentIndex) ?? "") + event.delta;
              if (nextPartialJson.length > MAX_TOOLCALL_REPAIR_BUFFER_CHARS) {
                partialJsonByIndex.delete(event.contentIndex);
                repairedArgsByIndex.delete(event.contentIndex);
                disabledIndices.add(event.contentIndex);
                return result;
              }
              partialJsonByIndex.set(event.contentIndex, nextPartialJson);
              const shouldReevaluateRepair =
                shouldAttemptMalformedToolCallRepair(nextPartialJson, event.delta) ||
                repairedArgsByIndex.has(event.contentIndex);
              if (shouldReevaluateRepair) {
                const hadRepairState = repairedArgsByIndex.has(event.contentIndex);
                const repair = tryExtractUsableToolCallArguments(nextPartialJson);
                if (repair) {
                  if (
                    !hadRepairState &&
                    (hasMeaningfulToolCallArgumentsInMessage(event.partial, event.contentIndex) ||
                      hasMeaningfulToolCallArgumentsInMessage(event.message, event.contentIndex))
                  ) {
                    hadPreexistingArgsByIndex.add(event.contentIndex);
                  }
                  repairedArgsByIndex.set(event.contentIndex, repair.args);
                  repairToolCallArgumentsInMessage(event.partial, event.contentIndex, repair.args);
                  repairToolCallArgumentsInMessage(event.message, event.contentIndex, repair.args);
                  if (!loggedRepairIndices.has(event.contentIndex) && repair.kind === "repaired") {
                    loggedRepairIndices.add(event.contentIndex);
                    log.warn(
                      `repairing Kimi tool call arguments with ${repair.leadingPrefix.length} leading chars and ${repair.trailingSuffix.length} trailing chars`,
                    );
                  }
                } else {
                  repairedArgsByIndex.delete(event.contentIndex);
                  // Keep args that were already present on the streamed message, but
                  // clear repair-only state so stale repaired args do not get replayed.
                  const hadPreexistingArgs =
                    hadPreexistingArgsByIndex.has(event.contentIndex) ||
                    (!hadRepairState &&
                      (hasMeaningfulToolCallArgumentsInMessage(event.partial, event.contentIndex) ||
                        hasMeaningfulToolCallArgumentsInMessage(
                          event.message,
                          event.contentIndex,
                        )));
                  if (!hadPreexistingArgs) {
                    clearToolCallArgumentsInMessage(event.partial, event.contentIndex);
                    clearToolCallArgumentsInMessage(event.message, event.contentIndex);
                  }
                }
              }
            }
            if (
              typeof event.contentIndex === "number" &&
              Number.isInteger(event.contentIndex) &&
              event.type === "toolcall_end"
            ) {
              const repairedArgs = repairedArgsByIndex.get(event.contentIndex);
              if (repairedArgs) {
                if (event.toolCall && typeof event.toolCall === "object") {
                  (event.toolCall as { arguments?: unknown }).arguments = repairedArgs;
                }
                repairToolCallArgumentsInMessage(event.partial, event.contentIndex, repairedArgs);
                repairToolCallArgumentsInMessage(event.message, event.contentIndex, repairedArgs);
              }
              partialJsonByIndex.delete(event.contentIndex);
              hadPreexistingArgsByIndex.delete(event.contentIndex);
              disabledIndices.delete(event.contentIndex);
              loggedRepairIndices.delete(event.contentIndex);
            }
          }
          return result;
        },
        async return(value?: unknown) {
          return iterator.return?.(value) ?? { done: true as const, value: undefined };
        },
        async throw(error?: unknown) {
          return iterator.throw?.(error) ?? { done: true as const, value: undefined };
        },
      };
    };

  return stream;
}

export function wrapStreamFnRepairMalformedToolCallArguments(baseFn: StreamFn): StreamFn {
  return (model, context, options) => {
    const maybeStream = baseFn(model, context, options);
    if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
      return Promise.resolve(maybeStream).then((stream) =>
        wrapStreamRepairMalformedToolCallArguments(stream),
      );
    }
    return wrapStreamRepairMalformedToolCallArguments(maybeStream);
  };
}

export function shouldRepairMalformedAnthropicToolCallArguments(provider?: string): boolean {
  return normalizeProviderId(provider ?? "") === "kimi";
}

export function wrapStreamFnDecodeXaiToolCallArguments(baseFn: StreamFn): StreamFn {
  return createHtmlEntityToolCallArgumentDecodingWrapper(baseFn);
}

export { decodeHtmlEntitiesInObject };
