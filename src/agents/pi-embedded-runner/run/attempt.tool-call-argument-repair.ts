import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import { normalizeProviderId } from "../../model-selection.js";
import { log } from "../logger.js";

function isToolCallBlockType(type: unknown): boolean {
  return type === "toolCall" || type === "toolUse" || type === "functionCall";
}

type BalancedJsonPrefix = {
  json: string;
  startIndex: number;
};

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
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
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

function tryParseMalformedToolCallArguments(raw: string): ToolCallArgumentRepair | undefined {
  if (!raw.trim()) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? { args: parsed as Record<string, unknown>, trailingSuffix: "" }
      : undefined;
  } catch {
    const extracted = extractBalancedJsonPrefix(raw);
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
    try {
      const parsed = JSON.parse(extracted.json) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? {
            args: parsed as Record<string, unknown>,
            leadingPrefix,
            trailingSuffix: suffix,
          }
        : undefined;
    } catch {
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
  const disabledIndices = new Set<number>();
  const loggedRepairIndices = new Set<number>();
  const originalResult = stream.result.bind(stream);
  stream.result = async () => {
    const message = await originalResult();
    repairMalformedToolCallArgumentsInMessage(message, repairedArgsByIndex);
    partialJsonByIndex.clear();
    repairedArgsByIndex.clear();
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
              if (shouldAttemptMalformedToolCallRepair(nextPartialJson, event.delta)) {
                const repair = tryParseMalformedToolCallArguments(nextPartialJson);
                if (repair) {
                  repairedArgsByIndex.set(event.contentIndex, repair.args);
                  repairToolCallArgumentsInMessage(event.partial, event.contentIndex, repair.args);
                  repairToolCallArgumentsInMessage(event.message, event.contentIndex, repair.args);
                  if (
                    !loggedRepairIndices.has(event.contentIndex) &&
                    repair.trailingSuffix.length > 0
                  ) {
                    loggedRepairIndices.add(event.contentIndex);
                    log.warn(
                      `repairing Kimi tool call arguments with ${repair.leadingPrefix.length} leading chars and ${repair.trailingSuffix.length} trailing chars`,
                    );
                  }
                } else {
                  repairedArgsByIndex.delete(event.contentIndex);
                  clearToolCallArgumentsInMessage(event.partial, event.contentIndex);
                  clearToolCallArgumentsInMessage(event.message, event.contentIndex);
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

const HTML_ENTITY_RE = /&(?:amp|lt|gt|quot|apos|#39|#x[0-9a-f]+|#\d+);/i;

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/gi, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)));
}

export function decodeHtmlEntitiesInObject(obj: unknown): unknown {
  if (typeof obj === "string") {
    return HTML_ENTITY_RE.test(obj) ? decodeHtmlEntities(obj) : obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(decodeHtmlEntitiesInObject);
  }
  if (obj && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = decodeHtmlEntitiesInObject(val);
    }
    return result;
  }
  return obj;
}

function decodeXaiToolCallArgumentsInMessage(message: unknown): void {
  if (!message || typeof message !== "object") {
    return;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return;
  }
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typedBlock = block as { type?: unknown; arguments?: unknown };
    if (typedBlock.type !== "toolCall" || !typedBlock.arguments) {
      continue;
    }
    if (typeof typedBlock.arguments === "object") {
      typedBlock.arguments = decodeHtmlEntitiesInObject(typedBlock.arguments);
    }
  }
}

function wrapStreamDecodeXaiToolCallArguments(
  stream: ReturnType<typeof streamSimple>,
): ReturnType<typeof streamSimple> {
  const originalResult = stream.result.bind(stream);
  stream.result = async () => {
    const message = await originalResult();
    decodeXaiToolCallArgumentsInMessage(message);
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
            const event = result.value as { partial?: unknown; message?: unknown };
            decodeXaiToolCallArgumentsInMessage(event.partial);
            decodeXaiToolCallArgumentsInMessage(event.message);
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

export function wrapStreamFnDecodeXaiToolCallArguments(baseFn: StreamFn): StreamFn {
  return (model, context, options) => {
    const maybeStream = baseFn(model, context, options);
    if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
      return Promise.resolve(maybeStream).then((stream) =>
        wrapStreamDecodeXaiToolCallArguments(stream),
      );
    }
    return wrapStreamDecodeXaiToolCallArguments(maybeStream);
  };
}
