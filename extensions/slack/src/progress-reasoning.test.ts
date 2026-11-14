import { describe, expect, it } from "vitest";
import {
  createSlackReasoningCardState,
  formatReasoningSummaryTitle,
  planSlackReasoningCards,
  tailReasoningSnippet,
} from "./progress-reasoning.js";

/** Reasoning text per card in code points (see `progress-reasoning.ts`). */
const CARD_CHARS = 240;

function words(count: number, prefix = "word"): string {
  return Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`).join(" ");
}

function segmentsOf(count: number): string[] {
  // Each entry fills one card on its own: 240 characters with no space.
  return Array.from({ length: count }, (_, index) => `${index + 1}`.padEnd(CARD_CHARS, "x"));
}

/** Card texts, without the lane prefix, that an open phase of `text` plans. */
function segmentReasoningText(text: string): string[] {
  return planSlackReasoningCards({ ...createSlackReasoningCardState(), open: text }).lines.map(
    (line) => line.text.replace(/^🧠 /u, ""),
  );
}

describe("reasoning card segmentation", () => {
  it("cuts at word boundaries and never exceeds the card size", () => {
    const text = words(120);
    const segments = segmentReasoningText(text);
    expect(segments.length).toBeGreaterThan(1);
    for (const segment of segments) {
      expect(Array.from(segment).length).toBeLessThanOrEqual(CARD_CHARS);
      expect(segment).not.toMatch(/^\s|\s$/u);
      expect(segment).toMatch(/^word\d+( word\d+)*$/u);
    }
    expect(segments.join(" ")).toBe(text);
  });

  it("keeps earlier segments byte-identical as the text grows", () => {
    const full = words(300);
    const prefixes = [40, 80, 160, 240, 300].map((count) => words(count));
    const finalSegments = segmentReasoningText(full);
    for (const prefix of prefixes) {
      const segments = segmentReasoningText(prefix);
      for (const [index, segment] of segments.slice(0, -1).entries()) {
        expect(segment).toBe(finalSegments[index]);
      }
    }
  });

  it("hard-cuts a run without spaces and collapses whitespace", () => {
    const run = "y".repeat(CARD_CHARS * 2 + 10);
    expect(segmentReasoningText(run).map((segment) => segment.length)).toEqual([240, 240, 10]);
    expect(segmentReasoningText("  first\n\nline \t second  ")).toEqual(["first line second"]);
    expect(segmentReasoningText("   ")).toEqual([]);
  });

  it("counts code points so an emoji cannot be split", () => {
    const text = "🧠".repeat(CARD_CHARS + 1);
    const segments = segmentReasoningText(text);
    expect(segments.map((segment) => Array.from(segment).length)).toEqual([240, 1]);
  });
});

describe("tailReasoningSnippet", () => {
  it("returns short text unchanged and marks a trimmed tail", () => {
    expect(tailReasoningSnippet("short thought")).toBe("short thought");
    const snippet = tailReasoningSnippet(words(200));
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("word200")).toBe(true);
    expect(Array.from(snippet).length).toBeLessThanOrEqual(CARD_CHARS);
    expect(snippet.slice(1)).toMatch(/^word\d+( word\d+)*$/u);
  });
});

describe("planSlackReasoningCards", () => {
  it("renders one in-progress card for an open segment and completes it when sealed", () => {
    const state = { ...createSlackReasoningCardState(), open: "Reading the handler" };
    expect(planSlackReasoningCards(state)).toEqual({
      cardsEmitted: 1,
      lines: [
        {
          id: "reasoning:1",
          kind: "item",
          text: "🧠 Reading the handler",
          label: "Reasoning",
          prefix: false,
        },
      ],
    });
    expect(
      planSlackReasoningCards({
        ...createSlackReasoningCardState(),
        sealed: ["Reading the handler"],
      }).lines,
    ).toEqual([
      {
        id: "reasoning:1",
        kind: "item",
        text: "🧠 Reading the handler",
        label: "Reasoning",
        prefix: false,
        status: "completed",
      },
    ]);
  });

  it("completes every segment but the newest and keeps post-tool text out of pre-tool cards", () => {
    const state = {
      ...createSlackReasoningCardState(),
      sealed: ["Before the tool call."],
      open: "After the tool result.",
      toolCalls: 1,
    };
    const { lines } = planSlackReasoningCards(state);
    expect(lines.map((line) => [line.id, line.status ?? "open", line.text])).toEqual([
      ["reasoning:1", "completed", "🧠 Before the tool call."],
      ["reasoning:2", "open", "🧠 After the tool result."],
    ]);
  });

  it("rolls text past the budget into one tail card", () => {
    const state = { ...createSlackReasoningCardState(), open: segmentsOf(60).join(" ") };
    const { lines, cardsEmitted } = planSlackReasoningCards(state);
    expect(cardsEmitted).toBe(47);
    expect(lines).toHaveLength(48);
    expect(lines.slice(0, 47).map((line) => line.id)).toEqual(
      Array.from({ length: 47 }, (_, index) => `reasoning:${index + 1}`),
    );
    expect(lines.slice(0, 47).every((line) => line.status === "completed")).toBe(true);
    const tail = lines.at(-1);
    expect(tail?.id).toBe("reasoning:tail");
    expect(tail?.status).toBeUndefined();
    expect(tail?.text.startsWith("🧠 …")).toBe(true);
    // The tail keeps 239 characters plus the ellipsis, so a full 240-character segment loses its first character.
    expect(tail?.text).toBe(`🧠 …${segmentsOf(60)[59]?.slice(1)}`);
    for (const line of lines) {
      expect(Array.from(line.text).length).toBeLessThanOrEqual(250);
    }
  });

  it("reserves plan-block rows for tool calls but never drops below the minimum", () => {
    const open = segmentsOf(60).join(" ");
    expect(
      planSlackReasoningCards({ ...createSlackReasoningCardState(), open, toolCalls: 10 })
        .cardsEmitted,
    ).toBe(37);
    expect(
      planSlackReasoningCards({ ...createSlackReasoningCardState(), open, toolCalls: 45 })
        .cardsEmitted,
    ).toBe(8);
  });

  it("keeps already emitted card ids when later tool calls shrink the budget", () => {
    const open = segmentsOf(50).join(" ");
    const first = planSlackReasoningCards({ ...createSlackReasoningCardState(), open });
    expect(first.cardsEmitted).toBe(47);
    const later = planSlackReasoningCards({
      ...createSlackReasoningCardState(),
      sealed: segmentsOf(50),
      open: "more",
      toolCalls: 20,
      cardsEmitted: first.cardsEmitted,
    });
    expect(later.cardsEmitted).toBe(47);
    expect(later.lines.map((line) => line.id).slice(-2)).toEqual([
      "reasoning:47",
      "reasoning:tail",
    ]);
    expect(later.lines.at(-1)?.status).toBeUndefined();
  });

  it("completes the tail card once nothing is open", () => {
    const { lines } = planSlackReasoningCards({
      ...createSlackReasoningCardState(),
      sealed: segmentsOf(50),
    });
    expect(lines.at(-1)).toMatchObject({ id: "reasoning:tail", status: "completed" });
  });
});

describe("formatReasoningSummaryTitle", () => {
  it("rounds the elapsed time and pluralizes tool calls", () => {
    expect(formatReasoningSummaryTitle({ elapsedMs: 200, toolCalls: 0 })).toBe("Thought for 1s");
    expect(formatReasoningSummaryTitle({ elapsedMs: 61_600, toolCalls: 1 })).toBe(
      "Thought for 62s, 1 tool call",
    );
    expect(formatReasoningSummaryTitle({ elapsedMs: 4_400, toolCalls: 3 })).toBe(
      "Thought for 4s, 3 tool calls",
    );
  });
});
