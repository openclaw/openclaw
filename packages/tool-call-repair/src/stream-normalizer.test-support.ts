import { expect } from "vitest";
import { parseStandalonePlainTextToolCallBlocks } from "./payload.js";
import {
  normalizePlainTextToolCallStreamEvents,
  projectScrubbedPlainTextToolCallMessage,
  type PlainTextToolCallNameMatcher,
} from "./stream-normalizer.js";

export const matcher: PlainTextToolCallNameMatcher = {
  hasExactName: (name) => name === "read",
  hasNamePrefix: (prefix) => "read".startsWith(prefix),
};

export type Terminal = "done" | "eof" | "error";
type Event = Record<string, unknown>;
type Events = Event[];
type Stream = readonly Event[];
type NormalizeOptions = Parameters<typeof normalizePlainTextToolCallStreamEvents>[1];

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
  const lineBreakOffsets = new Set(parts.slice(0, -1).map((part) => (offset += part.length)));
  return parseStandalonePlainTextToolCallBlocks(parts.join(""), undefined, { lineBreakOffsets });
}

export const textContent = (...texts: string[]) => texts.map((text) => ({ type: "text", text }));

export function assistantMessage(content: unknown, stopReason?: string) {
  return { role: "assistant", content, ...(stopReason === undefined ? {} : { stopReason }) };
}

function streamEvent(type: string, fields: Event, partial?: unknown) {
  return { type, ...fields, ...(partial === undefined ? {} : { partial }) };
}

export const textDelta = (delta: string, snapshot: string) =>
  streamTextDelta(delta, 0, assistantMessage(textContent(snapshot)));

export const streamTextDelta = (delta: string, contentIndex = 0, partial?: unknown) =>
  streamEvent("text_delta", { contentIndex, delta }, partial);
export const textStart = (contentIndex: number, content = "", partial?: unknown) =>
  streamEvent("text_start", { contentIndex, content }, partial);
export const textEnd = (content: string, contentIndex = 0, partial?: unknown) =>
  streamEvent("text_end", { contentIndex, content }, partial);

export const doneEvent = (reason: string, message: unknown) =>
  streamEvent("done", { reason, message });

export const doneAssistantEvent = (reason: string, content: unknown, stopReason: string) =>
  doneEvent(reason, assistantMessage(content, stopReason));

export const errorEvent = (error: unknown, partial?: unknown) =>
  streamEvent("error", { error }, partial);

export async function collectNormalizedEvents(
  events: readonly unknown[],
  options: NormalizeOptions,
): Promise<Events> {
  async function* source() {
    yield* events;
  }
  const normalized: Events = [];
  for await (const event of normalizePlainTextToolCallStreamEvents(source(), options)) {
    if (event && typeof event === "object") {
      normalized.push(event as Event);
    }
  }
  return normalized;
}

export async function normalize(
  events: readonly unknown[],
  options: Pick<NormalizeOptions, "resolveProtectedRanges" | "protectedRangesFenceCompatible"> & {
    protectFences?: boolean;
  } = {},
): Promise<Events> {
  const resolveProtectedRanges =
    options.resolveProtectedRanges ?? (options.protectFences ? resolveTestFenceRanges : undefined);
  return collectNormalizedEvents(events, {
    matcher,
    createPromotedToolCallEvents: () => [],
    normalizeTerminalMessage: ({ message, preserveEmptyTextBlocks }) => {
      const scrubbed = projectScrubbedPlainTextToolCallMessage({
        matcher,
        message,
        preserveEmptyTextBlocks,
        resolveProtectedRanges,
      });
      return scrubbed ? { kind: "scrubbed", ...scrubbed } : undefined;
    },
    // Custom resolvers must explicitly opt into the carried fence scan.
    protectedRangesFenceCompatible:
      options.protectedRangesFenceCompatible ?? options.protectFences === true,
    resolveProtectedRanges,
  });
}

export const normalizeTextDeltas = (...deltas: string[]) =>
  normalize(deltas.map((delta) => streamTextDelta(delta)));

export function withTerminal(deltas: Stream, terminal: Terminal, snapshot: string): Events {
  if (terminal === "eof") {
    return [...deltas];
  }
  const message = assistantMessage(textContent(snapshot), "length");
  return terminal === "done"
    ? [...deltas, doneEvent("length", message)]
    : [...deltas, errorEvent({ content: textContent(snapshot) }, message)];
}

export function textDeltas(events: Stream): unknown[] {
  return events.filter((event) => event.type === "text_delta").map((event) => event.delta);
}

export const eventTypes = (events: Stream): unknown[] => events.map((event) => event.type);

export function expectTerminalContent(events: Stream, terminal: Terminal, content: unknown) {
  if (terminal === "done") {
    expect(events.at(-1)?.message).toMatchObject({ content });
  } else if (terminal === "error") {
    const partialContent =
      Array.isArray(content) && content.length === 0 ? textContent("") : content;
    expect(events.at(-1)?.partial).toMatchObject({ content: partialContent });
    expect(events.at(-1)?.error).toMatchObject({ content });
  }
}
