import { expect } from "vitest";
import { parseStandalonePlainTextToolCallBlocks } from "./payload.js";
import {
  normalizePlainTextToolCallStreamEvents,
  projectScrubbedPlainTextToolCallMessage,
  type PlainTextToolCallMessageNormalization,
  type PlainTextToolCallNameMatcher,
} from "./stream-normalizer.js";

export const matcher: PlainTextToolCallNameMatcher = {
  hasExactName: (name) => name === "read",
  hasNamePrefix: (prefix) => "read".startsWith(prefix),
};

export type Terminal = "done" | "eof" | "error";

export function resolveTestFenceRanges(text: string): Array<{ end: number; start: number }> {
  const ranges: Array<{ end: number; start: number }> = [];
  let cursor = 0;
  while (cursor < text.length) {
    const backtick = text.indexOf("```", cursor);
    const tilde = text.indexOf("~~~", cursor);
    const start = backtick === -1 ? tilde : tilde === -1 ? backtick : Math.min(backtick, tilde);
    if (start === -1) {
      break;
    }
    const marker = text.slice(start, start + 3);
    const close = text.indexOf(marker, start + marker.length);
    const end = close === -1 ? text.length : close + marker.length;
    ranges.push({ start, end });
    cursor = end;
  }
  return ranges;
}

export function parseSplitCall(parts: readonly string[]) {
  let offset = 0;
  const lineBreakOffsets = new Set(
    parts.slice(0, -1).map((part) => {
      offset += part.length;
      return offset;
    }),
  );
  return parseStandalonePlainTextToolCallBlocks(parts.join(""), undefined, {
    lineBreakOffsets,
  });
}

export function textContent(...texts: string[]) {
  return texts.map((text) => ({ type: "text", text }));
}

export function assistantMessage(content: unknown, stopReason?: string) {
  return { role: "assistant", content, ...(stopReason === undefined ? {} : { stopReason }) };
}

function streamEvent(type: string, fields: Record<string, unknown>) {
  return { type, ...fields };
}

export function textDelta(delta: string, snapshot: string) {
  return streamEvent("text_delta", {
    contentIndex: 0,
    delta,
    partial: assistantMessage(textContent(snapshot)),
  });
}

export function streamTextDelta(delta: string, contentIndex = 0, partial?: unknown) {
  return streamEvent("text_delta", {
    contentIndex,
    delta,
    ...(partial === undefined ? {} : { partial }),
  });
}

export function textStart(contentIndex: number, content = "", partial?: unknown) {
  return streamEvent("text_start", {
    contentIndex,
    content,
    ...(partial === undefined ? {} : { partial }),
  });
}

export function textEnd(content: string, contentIndex = 0, partial?: unknown) {
  return streamEvent("text_end", {
    contentIndex,
    content,
    ...(partial === undefined ? {} : { partial }),
  });
}

export function doneEvent(reason: string, message: unknown) {
  return streamEvent("done", { reason, message });
}

export function doneAssistantEvent(reason: string, content: unknown, stopReason: string) {
  return doneEvent(reason, assistantMessage(content, stopReason));
}

export function errorEvent(error: unknown, partial?: unknown) {
  return streamEvent("error", { ...(partial === undefined ? {} : { partial }), error });
}

export async function collectNormalizedEvents(
  events: readonly unknown[],
  options: Parameters<typeof normalizePlainTextToolCallStreamEvents>[1],
): Promise<Record<string, unknown>[]> {
  async function* source() {
    yield* events;
  }
  const normalized: Record<string, unknown>[] = [];
  for await (const event of normalizePlainTextToolCallStreamEvents(source(), options)) {
    if (event && typeof event === "object") {
      normalized.push(event as Record<string, unknown>);
    }
  }
  return normalized;
}

export async function normalize(
  events: readonly unknown[],
  options: { protectFences?: boolean } = {},
): Promise<Record<string, unknown>[]> {
  const scrubMessage = (message: unknown, scrubOptions?: { preserveEmptyTextBlocks?: boolean }) =>
    projectScrubbedPlainTextToolCallMessage({
      matcher,
      message,
      preserveEmptyTextBlocks: scrubOptions?.preserveEmptyTextBlocks,
      resolveProtectedRanges: options.protectFences ? resolveTestFenceRanges : undefined,
    });
  return collectNormalizedEvents(events, {
    matcher,
    createPromotedToolCallEvents: () => [],
    normalizeTerminalMessage: ({
      message,
      preserveEmptyTextBlocks,
    }): PlainTextToolCallMessageNormalization => {
      const scrubbed = scrubMessage(message, { preserveEmptyTextBlocks });
      return scrubbed ? { kind: "scrubbed", ...scrubbed } : undefined;
    },
    // resolveTestFenceRanges protects exactly fenced regions, the shape the carried fence
    // scan models, so these fence-suite tests opt the fast path in.
    protectedRangesFenceCompatible: options.protectFences === true,
    resolveProtectedRanges: options.protectFences ? resolveTestFenceRanges : undefined,
  });
}

export function normalizeTextDeltas(...deltas: string[]) {
  return normalize(deltas.map((delta) => streamTextDelta(delta)));
}

export function withTerminal(
  deltas: readonly Record<string, unknown>[],
  terminal: Terminal,
  snapshot: string,
): Record<string, unknown>[] {
  if (terminal === "eof") {
    return [...deltas];
  }
  const message = assistantMessage(textContent(snapshot), "length");
  return terminal === "done"
    ? [...deltas, doneEvent("length", message)]
    : [...deltas, errorEvent({ content: textContent(snapshot) }, message)];
}

export function textDeltas(events: readonly Record<string, unknown>[]): unknown[] {
  return events.filter((event) => event.type === "text_delta").map((event) => event.delta);
}

export function eventTypes(events: readonly Record<string, unknown>[]): unknown[] {
  return events.map((event) => event.type);
}

export function expectTerminalContent(
  events: readonly Record<string, unknown>[],
  terminal: Terminal,
  content: unknown,
) {
  if (terminal === "done") {
    expect(events.at(-1)?.message).toMatchObject({ content });
  } else if (terminal === "error") {
    const partialContent =
      Array.isArray(content) && content.length === 0 ? textContent("") : content;
    expect(events.at(-1)?.partial).toMatchObject({ content: partialContent });
    expect(events.at(-1)?.error).toMatchObject({ content });
  }
}
