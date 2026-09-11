import { describe, expect, it } from "vitest";
import {
  createSlackReasoningCardState,
  formatReasoningSummaryTitle,
  planSlackReasoningCards,
  rolloverSlackReasoningCards,
  sealSlackReasoningCards,
} from "./progress-reasoning.js";

/** Reasoning text per card in UTF-8 bytes (see `progress-reasoning.ts`). */
const CARD_BYTES = 240;

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function words(count: number, prefix = "word"): string {
  return Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`).join(" ");
}

function segmentsOf(count: number): string[] {
  // Each entry fills one card on its own: 240 characters with no space.
  return Array.from({ length: count }, (_, index) => `${index + 1}`.padEnd(CARD_BYTES, "x"));
}

/** Card texts, without the lane prefix, that an open phase of `text` plans. */
function segmentReasoningText(text: string): string[] {
  return planSlackReasoningCards({ ...createSlackReasoningCardState(), open: text }).map((line) =>
    line.text.replace(/^🧠 /u, ""),
  );
}

describe("reasoning card segmentation", () => {
  it("cuts at word boundaries and never exceeds the card size", () => {
    const text = words(120);
    const segments = segmentReasoningText(text);
    expect(segments.length).toBeGreaterThan(1);
    for (const segment of segments) {
      expect(utf8Bytes(segment)).toBeLessThanOrEqual(CARD_BYTES);
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
    const run = "y".repeat(CARD_BYTES * 2 + 10);
    expect(segmentReasoningText(run).map((segment) => segment.length)).toEqual([240, 240, 10]);
    expect(segmentReasoningText("  first\n\nline \t second  ")).toEqual(["first line second"]);
    expect(segmentReasoningText("   ")).toEqual([]);
  });

  it("measures UTF-8 bytes without splitting a code point", () => {
    // 61 emoji are 244 bytes: 60 fill one card exactly, the last starts the next.
    const emoji = "🧠".repeat(CARD_BYTES / 4 + 1);
    expect(segmentReasoningText(emoji).map((segment) => utf8Bytes(segment))).toEqual([240, 4]);
    expect(segmentReasoningText(emoji).map((segment) => Array.from(segment).length)).toEqual([
      60, 1,
    ]);
    // CJK is three bytes per character: 81 characters are 243 bytes.
    const cjk = "字".repeat(CARD_BYTES / 3 + 1);
    expect(segmentReasoningText(cjk).map((segment) => utf8Bytes(segment))).toEqual([240, 3]);
    // Emoji-heavy prose: the space cut still lands in the second half of the window.
    const prose = Array.from({ length: 200 }, () => "🧠🔍🧪").join(" ");
    const proseSegments = segmentReasoningText(prose);
    for (const [index, segment] of proseSegments.entries()) {
      expect(utf8Bytes(segment)).toBeLessThanOrEqual(CARD_BYTES);
      if (index < proseSegments.length - 1) {
        expect(utf8Bytes(segment)).toBeGreaterThan(CARD_BYTES / 2);
      }
      expect(segment).toMatch(/^🧠🔍🧪( 🧠🔍🧪)*$/u);
    }
  });
});

describe("planSlackReasoningCards", () => {
  it("renders one in-progress card for an open segment and completes it when sealed", () => {
    const state = { ...createSlackReasoningCardState(), open: "Reading the handler" };
    expect(planSlackReasoningCards(state)).toEqual([
      {
        id: "reasoning:1",
        kind: "item",
        text: "🧠 Reading the handler",
        label: "Reasoning",
        prefix: false,
      },
    ]);
    expect(
      planSlackReasoningCards({
        ...createSlackReasoningCardState(),
        sealed: ["Reading the handler"],
      }),
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
    expect(planSlackReasoningCards(createSlackReasoningCardState())).toEqual([]);
  });

  it("completes every segment but the newest and keeps post-tool text out of pre-tool cards", () => {
    const state = {
      ...createSlackReasoningCardState(),
      sealed: ["Before the tool call."],
      open: "After the tool result.",
      toolCalls: 1,
    };
    expect(
      planSlackReasoningCards(state).map((line) => [line.id, line.status ?? "open", line.text]),
    ).toEqual([
      ["reasoning:1", "completed", "🧠 Before the tool call."],
      ["reasoning:2", "open", "🧠 After the tool result."],
    ]);
  });

  it("numbers every segment of a long think; the stream pipeline places them", () => {
    const state = { ...createSlackReasoningCardState(), open: segmentsOf(60).join(" ") };
    const lines = planSlackReasoningCards(state);
    expect(lines.map((line) => line.id)).toEqual(
      Array.from({ length: 60 }, (_, index) => `reasoning:${index + 1}`),
    );
    expect(lines.slice(0, 59).every((line) => line.status === "completed")).toBe(true);
    expect(lines.at(-1)?.status).toBeUndefined();
    for (const line of lines) {
      expect(utf8Bytes(line.text)).toBeLessThanOrEqual(250);
    }
  });
});

describe("rolloverSlackReasoningCards", () => {
  it("closes the cards on the rolled message and continues the open phase in new cards", () => {
    const state = { ...createSlackReasoningCardState(), open: segmentsOf(5).join(" ") };
    const before = planSlackReasoningCards(state);
    // Cards 1-3 landed on the finished message; 4 and 5 were deferred to the next one.
    rolloverSlackReasoningCards(state, 3);
    expect(state.sealed).toEqual(segmentsOf(3));
    const after = planSlackReasoningCards(state);
    // Cards 4 and 5 are re-cut from the open text past the sealed prefix, unchanged.
    expect(after.map((line) => line.text)).toEqual(before.map((line) => line.text));
    expect(after.map((line) => line.status ?? "open")).toEqual([
      "completed",
      "completed",
      "completed",
      "completed",
      "open",
    ]);
  });

  it("keeps merging cumulative snapshots of the same phase without repeating sealed text", () => {
    const state = { ...createSlackReasoningCardState(), open: segmentsOf(2).join(" ") };
    rolloverSlackReasoningCards(state, 2);
    // Nothing is open past the sealed prefix, so both cards are complete and no card is open.
    expect(planSlackReasoningCards(state).map((line) => line.status)).toEqual([
      "completed",
      "completed",
    ]);
    // The compositor keeps the whole phase; only the tail past the sealed prefix forms cards.
    state.open = segmentsOf(4).join(" ");
    const lines = planSlackReasoningCards(state);
    expect(lines.map((line) => [line.id, line.status ?? "open"])).toEqual([
      ["reasoning:1", "completed"],
      ["reasoning:2", "completed"],
      ["reasoning:3", "completed"],
      ["reasoning:4", "open"],
    ]);
    expect(lines[2]?.text).toBe(`🧠 ${segmentsOf(4)[2]}`);
  });

  it("seals the partial open card when it was on the rolled message and starts the next card after it", () => {
    const state = { ...createSlackReasoningCardState(), open: "Half a thought" };
    rolloverSlackReasoningCards(state, 1);
    state.open = "Half a thought that goes on";
    expect(planSlackReasoningCards(state).map((line) => [line.id, line.text])).toEqual([
      ["reasoning:1", "🧠 Half a thought"],
      ["reasoning:2", "🧠 that goes on"],
    ]);
  });

  it("is a no-op when no card of the open phase was on the rolled message", () => {
    const state = {
      ...createSlackReasoningCardState(),
      sealed: ["Before the tool call."],
      open: "After it.",
    };
    rolloverSlackReasoningCards(state, 1);
    expect(state).toEqual({
      sealed: ["Before the tool call."],
      open: "After it.",
      openSealedPrefix: "",
      toolCalls: 0,
    });
  });

  it("lets a seal after a rollover close the phase and clear the prefix", () => {
    const state = { ...createSlackReasoningCardState(), open: segmentsOf(3).join(" ") };
    rolloverSlackReasoningCards(state, 2);
    sealSlackReasoningCards(state);
    expect(state.sealed).toEqual(segmentsOf(3));
    expect(state.open).toBe("");
    expect(state.openSealedPrefix).toBe("");
    state.open = "New phase";
    expect(planSlackReasoningCards(state).at(-1)).toMatchObject({
      id: "reasoning:4",
      text: "🧠 New phase",
    });
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
