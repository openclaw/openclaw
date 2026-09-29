import { describe, expect, it, vi } from "vitest";
import { projectScrubbedPlainTextToolCallMessage } from "./stream-normalizer.js";
import {
  assistantMessage,
  collectNormalizedEvents,
  doneAssistantEvent,
  matcher,
  normalize,
  resolveTestFenceRanges,
  streamTextDelta,
  textContent,
  textDeltas,
  textEnd,
} from "./stream-normalizer.test-support.js";

function normalizeProtectedDeltas(
  events: readonly unknown[],
  resolveProtectedRanges = resolveTestFenceRanges,
) {
  return collectNormalizedEvents(events, {
    matcher,
    createPromotedToolCallEvents: () => [],
    normalizeTerminalMessage: () => undefined,
    protectedRangesFenceCompatible: true,
    resolveProtectedRanges,
  });
}

function streamedText(events: readonly Record<string, unknown>[]) {
  return events
    .map((event) =>
      typeof event.delta === "string"
        ? event.delta
        : typeof event.content === "string"
          ? event.content
          : "",
    )
    .join("");
}

describe("normalizePlainTextToolCallStreamEvents protected ranges", () => {
  it("preserves fenced calls when the opener and call are split across live deltas", async () => {
    const parts = ["`", "``json\n", "[re", 'ad]\n{"path":"example.txt"}\n[/read]\n', "```"];
    const text = parts.join("");
    const events = await normalize(
      [
        ...parts.map((delta) => streamTextDelta(delta)),
        doneAssistantEvent("stop", textContent(text), "stop"),
      ],
      { protectFences: true },
    );

    expect(textDeltas(events).join("")).toBe(text);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      message: { content: textContent(text), stopReason: "stop" },
    });
    expect(events.some((event) => String(event.type).startsWith("toolcall_"))).toBe(false);
  });

  it("preserves fence ownership across adjacent text content blocks", async () => {
    const first = "```json\n";
    const second = ["[read]", '{"path":"example.txt"}', "[/read]", "```"].join("\n");
    const content = textContent(first, second);
    const events = await normalize(
      [
        streamTextDelta(first),
        textEnd(first, 0),
        streamTextDelta(second, 1),
        textEnd(second, 1),
        doneAssistantEvent("stop", content, "stop"),
      ],
      { protectFences: true },
    );

    expect(textDeltas(events).join("")).toBe(first + second);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      message: { content, stopReason: "stop" },
    });
    expect(events.some((event) => String(event.type).startsWith("toolcall_"))).toBe(false);
  });

  it("uses cumulative partials when earlier fenced blocks were not streamed, even with a complete final line (#122513)", async () => {
    // A trailing newline prevents the unfinished-line fallback from masking missing context.
    const first = "```json\n";
    const candidate = ["[read]", '{"path":"example.txt"}', "[/read]", "```", ""].join("\n");
    const content = textContent(first, candidate);
    const events = await normalize(
      [
        streamTextDelta(candidate, 1, assistantMessage(content)),
        textEnd(candidate, 1, assistantMessage(content)),
        doneAssistantEvent("stop", content, "stop"),
      ],
      { protectFences: true },
    );

    expect(textDeltas(events).join("")).toBe(candidate);
    expect(events.some((event) => String(event.type).startsWith("toolcall_"))).toBe(false);
  });

  it("recognizes a real call in an earlier block when a later block streams its fence first (#122513)", async () => {
    // Event order and content-index order disagree about the preceding fence.
    const candidate = ["[read]", '{"path":"example.txt"}', "[/read]", ""].join("\n");
    const second = "```json\n";
    // Terminal reparsing would mask a wrong live-delta verdict.
    const events = await normalizeProtectedDeltas([
      streamTextDelta(second, 1, assistantMessage(textContent("", second))),
      streamTextDelta(candidate, 0, assistantMessage(textContent(candidate, second))),
    ]);

    expect(streamedText(events)).not.toContain('{"path":"example.txt"}');
  });

  it("does not trust a same-length prefix that came from a different block order (#122513)", async () => {
    // Equal prefix lengths hide opposite fence identities in event versus content order.
    const block1 = "```\n";
    const block0 = "~~~\n";
    const candidate = ["```", "[read]", '{"path":"example.txt"}', "[/read]", "```", ""].join("\n");
    const events = await normalizeProtectedDeltas([
      streamTextDelta(block1, 1, assistantMessage(textContent("", block1))),
      streamTextDelta(block0, 0, assistantMessage(textContent(block0, block1))),
      streamTextDelta(candidate, 2, assistantMessage(textContent(block0, block1, candidate))),
    ]);

    expect(streamedText(events)).toContain('{"path":"example.txt"}');
  });

  it("does not cache trust from a candidate with no partial at all (#122513)", async () => {
    // Missing partials must not cache trust for a later partial that contradicts event order.
    const block1 = "```\n";
    const firstCall = "[read]\n{}\n[/read]\n";
    const secondCandidate = ["```", "[read]", '{"path":"x"}', "[/read]", "```", ""].join("\n");
    const events = await normalizeProtectedDeltas([
      streamTextDelta(block1, 1),
      streamTextDelta(firstCall, 0),
      streamTextDelta(
        secondCandidate,
        0,
        assistantMessage(textContent(`~~~\n${firstCall}${secondCandidate}`, block1)),
      ),
    ]);

    expect(streamedText(events)).toContain('{"path":"x"}');
  });

  it("invalidates a cached preceding-context verdict when the earlier block grows (#122513)", async () => {
    // A growing earlier block closes the fence without switching the active content index.
    const block0First = "~~~\n";
    const firstCall = "[read]\n{}\n[/read]\n";
    const secondCandidate = ["[read]", '{"path":"x"}', "[/read]", ""].join("\n");
    const block0Grown = `${block0First}~~~\n`;
    const events = await normalizeProtectedDeltas([
      streamTextDelta(block0First, 0),
      streamTextDelta(firstCall, 1, assistantMessage(textContent(block0First, firstCall))),
      streamTextDelta(
        secondCandidate,
        1,
        assistantMessage(textContent(block0Grown, `${firstCall}${secondCandidate}`)),
      ),
    ]);

    expect(streamedText(events)).not.toContain('{"path":"x"}');
  });

  it("preserves candidate bytes after bounded protection history overflows", async () => {
    const opening = `\`\`\`text\n${"x".repeat(1_000_000)}`;
    const candidate = ["[read]", '{"path":"example.txt"}', "[/read]"].join("\n");
    const events = await normalize([streamTextDelta(opening), streamTextDelta(candidate)], {
      protectFences: true,
    });

    expect(textDeltas(events).join("")).toBe(opening + candidate);
  });

  it("materializes accumulated Markdown when an inline span blocks the fast path", async () => {
    const resolvedLengths: number[] = [];
    // Inline spans require the full resolver despite opting into fence tracking.
    const visibleChunks = Array.from({ length: 1_000 }, () => "ordinary `code` prose\n");
    const candidate = ["[read]", '{"path":"example.txt"}', "[/read]"].join("\n");
    const events = await normalizeProtectedDeltas(
      [...visibleChunks.map((delta) => streamTextDelta(delta)), streamTextDelta(candidate)],
      (text) => {
        resolvedLengths.push(text.length);
        return [];
      },
    );

    expect(resolvedLengths[0]).toBe(visibleChunks.join("").length + candidate.length);
    expect(resolvedLengths.length).toBeLessThanOrEqual(3);
    expect(textDeltas(events).join("")).toBe(visibleChunks.join(""));
  });

  it("does not carry an open fence from a finished completion into the next one", async () => {
    const firstText = "```toml\n[read.section]\n";
    const call = ["[read]", '{"path":"secret.txt"}', "[/read]"].join("\n");
    const events = await normalize(
      [
        streamTextDelta(firstText),
        doneAssistantEvent("stop", textContent(firstText), "stop"),
        streamTextDelta(`${call}\n`),
        doneAssistantEvent("stop", textContent(`${call}\n`), "stop"),
      ],
      { protectFences: true },
    );

    expect(textDeltas(events).join("")).not.toContain('{"path":"secret.txt"}');
  });

  it("keeps protection resolution bounded across a bracket-dense fenced answer", async () => {
    let resolverCalls = 0;
    // Candidate-shaped lines stay literal, with every bracket split into its own delta.
    const fenced = [
      "```toml",
      ...Array.from({ length: 300 }, (_, index) => `[read.section.${index}]\nname = "svc"`),
      "```",
      "",
    ].join("\n");
    const deltas = fenced.split(/(?<=\[)/);
    const events = await normalizeProtectedDeltas(
      deltas.map((delta) => streamTextDelta(delta)),
      (text) => {
        resolverCalls += 1;
        return resolveTestFenceRanges(text);
      },
    );

    // Count parses instead of timing the formerly quadratic work.
    expect(resolverCalls).toBeLessThanOrEqual(3);
    expect(textDeltas(events).join("")).toBe(fenced);
  });

  it("keeps a large preceding block's prefix check bounded across many later candidates (#122513)", async () => {
    // End the preceding line so the next block opens a CommonMark fence.
    const precedingBlock = `${"x".repeat(199_999)}\n`;
    const fenced = [
      "```toml",
      ...Array.from({ length: 300 }, (_, index) => `[read.section.${index}]\nname = "svc"`),
      "```",
      "",
    ].join("\n");
    const deltas = fenced.split(/(?<=\[)/);
    let accumulated = "";
    const events = [
      streamTextDelta(precedingBlock, 0, assistantMessage(textContent(precedingBlock, ""))),
      ...deltas.map((delta) => {
        accumulated += delta;
        return streamTextDelta(
          delta,
          1,
          assistantMessage(textContent(precedingBlock, accumulated)),
        );
      }),
    ];

    let resolverCalls = 0;
    let precedingPrefixSlices = 0;
    // oxlint-disable-next-line typescript/unbound-method -- called below with the intercepted string receiver.
    const originalSlice = String.prototype.slice;
    const sliceSpy = vi.spyOn(String.prototype, "slice").mockImplementation(function (
      this: string,
      start,
      end,
    ) {
      if (start === 0 && end === precedingBlock.length && this.length >= end) {
        precedingPrefixSlices += 1;
      }
      return originalSlice.call(this, start, end);
    });
    let normalized: Record<string, unknown>[];
    try {
      normalized = await normalizeProtectedDeltas(events, (text) => {
        resolverCalls += 1;
        return resolveTestFenceRanges(text);
      });
    } finally {
      sliceSpy.mockRestore();
    }

    expect(resolverCalls).toBeLessThanOrEqual(3);
    // Rechecking the entire preceding block for every candidate makes work quadratic.
    // Count full-prefix operations so this bound does not depend on runner speed.
    expect(precedingPrefixSlices).toBeLessThanOrEqual(4);
    expect(textDeltas(normalized).join("")).toBe(precedingBlock + fenced);
  });

  it("still protects an unfenced caller-defined range when the fast path is not opted in", async () => {
    // Custom ranges are authoritative unless the caller opts into CommonMark fence tracking.
    const OPEN_MARK = "<<PROTECT>>";
    const CLOSE_MARK = "<<END>>";
    const resolveMarkedRanges = (text: string) => {
      const ranges: Array<{ end: number; start: number }> = [];
      let cursor = 0;
      for (;;) {
        const start = text.indexOf(OPEN_MARK, cursor);
        if (start === -1) {
          break;
        }
        const close = text.indexOf(CLOSE_MARK, start + OPEN_MARK.length);
        const end = close === -1 ? text.length : close + CLOSE_MARK.length;
        ranges.push({ start, end });
        cursor = end;
      }
      return ranges;
    };
    const call = ["[read]", '{"path":"secret.txt"}', "[/read]"].join("\n");
    // Complete lines prevent the unfinished-line fallback from masking an incorrect opt-in.
    const text = `${OPEN_MARK}\n${call}\n${CLOSE_MARK}\n`;
    const events = await collectNormalizedEvents(
      [streamTextDelta(text), doneAssistantEvent("stop", textContent(text), "stop")],
      {
        matcher,
        createPromotedToolCallEvents: () => [],
        normalizeTerminalMessage: ({ message }) => {
          const scrubbed = projectScrubbedPlainTextToolCallMessage({
            matcher,
            message,
            resolveProtectedRanges: resolveMarkedRanges,
          });
          return scrubbed ? { kind: "scrubbed", ...scrubbed } : undefined;
        },
        resolveProtectedRanges: resolveMarkedRanges,
      },
    );

    expect(textDeltas(events).join("")).toBe(text);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      message: { content: textContent(text), stopReason: "stop" },
    });
  });
});
