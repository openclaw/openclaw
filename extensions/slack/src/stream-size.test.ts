import type { AnyChunk } from "@slack/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { planSlackStreamUpdateFit, SlackStreamMessageLedger } from "./stream-size.js";

function task(
  id: string,
  title: string,
  extra?: { details?: string; output?: string; status?: "in_progress" | "complete" },
): AnyChunk {
  return {
    type: "task_update",
    id,
    title,
    status: extra?.status ?? "in_progress",
    ...(extra?.details ? { details: extra.details } : {}),
    ...(extra?.output ? { output: extra.output } : {}),
  };
}

function card(index: number, chars = 242): AnyChunk {
  return task(`reasoning_${index}`, `🧠 ${String(index).padEnd(chars - 3, "x")}`);
}

describe("SlackStreamMessageLedger", () => {
  it("counts what Slack's size check counts", () => {
    const ledger = new SlackStreamMessageLedger();
    // Text: a character is one unit, an emoji its shortcode (rounded up to 20).
    ledger.record({ text: "🧠 ab" });
    expect(ledger.textSize).toBe(20 + 3);
    // Plan block JSON: 58 for the block, 49 + id per task, a CJK title escaped to six.
    ledger.record({ chunks: [task("a", "字")] });
    expect(ledger.rowSize).toBe(58 + 49 + 1 + 6);
    ledger.record({ text: undefined });
    expect(ledger.size).toBe(114 + 23);
    // Rich text: 132 for the field, an emoji element rounded up to 80; titles escape `/` and `"`.
    ledger.record({ chunks: [task("b", 'a/"', { details: "🧠x" })] });
    expect(ledger.rowSize).toBe(114 + 49 + 1 + 5 + 132 + 80 + 1);
  });

  it("never counts less than Slack did at its measured ceiling of 13,200", () => {
    const rows = (count: number, title: (index: number) => string): AnyChunk[] => [
      { type: "plan_update", title: "P" },
      ...Array.from({ length: count }, (_, index) =>
        task(`t${index}`, title(index), { status: "complete" }),
      ),
    ];
    // Each message below was accepted and one more unit was rejected.
    const accepted: Array<{ text: string; chunks?: AnyChunk[] }> = [
      { text: "x", chunks: rows(30, (index) => "a".repeat(index < 29 ? 400 : 81)) },
      { text: "x".repeat(6_000), chunks: rows(16, (index) => "a".repeat(index < 15 ? 400 : 368)) },
      { text: "x", chunks: rows(6, (index) => "漢".repeat(index < 5 ? 400 : 142)) },
      { text: "🧠".repeat(1_000) + "a".repeat(6_200) },
      { text: "✅".repeat(733) },
    ];
    for (const update of accepted) {
      const ledger = new SlackStreamMessageLedger();
      ledger.record(update);
      expect(ledger.size).toBeGreaterThanOrEqual(13_194);
    }
  });

  it("replaces titles and the plan title, appends details, output and text", () => {
    const ledger = new SlackStreamMessageLedger();
    ledger.record({
      chunks: [{ type: "plan_update", title: "Thinking" }, task("a", "12345", { details: "dd" })],
    });
    expect(ledger.rowSize).toBe(58 + 8 + (49 + 1 + 5) + (132 + 2));
    expect(ledger.taskCount).toBe(1);
    ledger.record({
      text: "hello",
      chunks: [
        { type: "plan_update", title: "Thought for 3s" },
        task("a", "1234567890", { details: "e", output: "+1 −2", status: "complete" }),
      ],
    });
    // Title 5 -> 10 counts once; details 2 + 1 share one field; output 10 (the minus sign is 6).
    expect(ledger.rowSize).toBe(58 + 14 + (49 + 1 + 10) + (132 + 3) + (132 + 10));
    expect(ledger.textSize).toBe(5);
    expect(ledger.size).toBe(ledger.rowSize + 5);
    ledger.record({ chunks: [{ type: "markdown_text", text: "!!" }] });
    expect(ledger.textSize).toBe(7);
    expect(ledger.hasTask("a")).toBe(true);
    expect(ledger.hasTask("b")).toBe(false);
  });

  it("clones without sharing rows", () => {
    const ledger = new SlackStreamMessageLedger();
    ledger.record({ chunks: [task("a", "abc")] });
    const copy = ledger.clone();
    copy.record({ chunks: [task("b", "defg"), task("a", "abcdef")] });
    expect(ledger.size).toBe(58 + 49 + 1 + 3);
    expect(copy.size).toBe(58 + (49 + 1 + 6) + (49 + 1 + 4));
    expect(ledger.isEmpty).toBe(false);
    expect(new SlackStreamMessageLedger().isEmpty).toBe(true);
  });
});

describe("planSlackStreamUpdateFit", () => {
  it("admits new rows in order up to the row budget and defers the rest", () => {
    const ledger = new SlackStreamMessageLedger();
    ledger.record({ chunks: [{ type: "plan_update", title: "Thinking" }] });
    const chunks = Array.from({ length: 30 }, (_, index) => card(index + 1));
    const fit = planSlackStreamUpdateFit(ledger, { chunks });
    // A card is 49 + its id (11-12) + its title (252, the emoji escapes to 12): 66 for
    // the block and title plus 22 cards is 6,943, under 7,000; the 23rd would not fit.
    expect(fit.fits).toBe(false);
    expect(fit.textFits).toBe(true);
    expect([...fit.admittedTaskIds]).toEqual(
      Array.from({ length: 22 }, (_, index) => `reasoning_${index + 1}`),
    );
    expect([...fit.deferredTaskIds]).toEqual(
      Array.from({ length: 8 }, (_, index) => `reasoning_${index + 23}`),
    );
  });

  it("admits new rows up to the ledger's task limit, kept by clone()", () => {
    const ledger = new SlackStreamMessageLedger(8);
    ledger.record({ chunks: [task("tool_1", "Bash")] });
    expect(ledger.clone().taskLimit).toBe(8);
    const fit = planSlackStreamUpdateFit(ledger.clone(), {
      chunks: Array.from({ length: 10 }, (_, index) => task(`tool_${index + 2}`, "Bash")),
    });
    expect(fit.admittedTaskIds.size).toBe(7);
    expect(fit.deferredTaskIds.size).toBe(3);
    // The limit never passes Slack's 50-row plan block.
    expect(new SlackStreamMessageLedger(80).taskLimit).toBe(50);
  });

  it("keeps deferring once a row is deferred so the plan stays in order", () => {
    const ledger = new SlackStreamMessageLedger();
    ledger.record({ chunks: Array.from({ length: 22 }, (_, index) => card(index + 1)) });
    const fit = planSlackStreamUpdateFit(ledger, {
      chunks: [card(23), task("tool_1", "🛠️ Bash"), card(24)],
    });
    expect([...fit.admittedTaskIds]).toEqual([]);
    expect([...fit.deferredTaskIds]).toEqual(["reasoning_23", "tool_1", "reasoning_24"]);
  });

  it("always applies updates to rows already on the message", () => {
    const ledger = new SlackStreamMessageLedger();
    ledger.record({ chunks: Array.from({ length: 22 }, (_, index) => card(index + 1)) });
    const fit = planSlackStreamUpdateFit(ledger, {
      chunks: [
        { type: "plan_update", title: "Thought for 9s" },
        task("reasoning_22", "🧠 longer final text", { status: "complete" }),
      ],
    });
    expect(fit).toEqual({
      fits: true,
      textFits: true,
      admittedTaskIds: new Set(),
      deferredTaskIds: new Set(),
    });
  });

  it("caps a message at the rows Slack renders", () => {
    const ledger = new SlackStreamMessageLedger();
    ledger.record({
      chunks: Array.from({ length: 49 }, (_, index) => task(`tool_${index + 1}`, "🛠️ Bash")),
    });
    const fit = planSlackStreamUpdateFit(ledger, {
      chunks: [task("tool_50", "🛠️ Bash"), task("tool_51", "🛠️ Bash")],
    });
    expect([...fit.admittedTaskIds]).toEqual(["tool_50"]);
    expect([...fit.deferredTaskIds]).toEqual(["tool_51"]);
  });

  it("moves text that would pass the message budget to the next message", () => {
    const ledger = new SlackStreamMessageLedger();
    // 22 cards are 6,935 units of 10,500: 3,565 remain for text.
    ledger.record({ chunks: Array.from({ length: 22 }, (_, index) => card(index + 1)) });
    expect(planSlackStreamUpdateFit(ledger, { text: "a".repeat(3_566) }).textFits).toBe(false);
    expect(planSlackStreamUpdateFit(ledger, { text: "a".repeat(3_565) }).textFits).toBe(true);
    // Text counts before new rows: the answer takes the space, the row is deferred.
    const fit = planSlackStreamUpdateFit(ledger, { text: "a".repeat(3_000), chunks: [card(23)] });
    expect(fit.textFits).toBe(true);
    expect([...fit.deferredTaskIds]).toEqual(["reasoning_23"]);
  });

  it("lets an empty message take the text and a first row regardless of size", () => {
    const fit = planSlackStreamUpdateFit(new SlackStreamMessageLedger(), {
      text: "a".repeat(12_000),
      chunks: [card(1, 250), card(2)],
    });
    expect(fit.textFits).toBe(true);
    expect([...fit.admittedTaskIds]).toEqual(["reasoning_1"]);
    expect([...fit.deferredTaskIds]).toEqual(["reasoning_2"]);
  });
});

describe("slack stream message age", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("marks a message expiring once it reaches the roll age", () => {
    vi.useFakeTimers();
    const ledger = new SlackStreamMessageLedger();
    // Roll at eight minutes, before Slack closes the native stream at about ten.
    vi.advanceTimersByTime(8 * 60_000 - 1);
    expect(ledger.expiring).toBe(false);
    vi.advanceTimersByTime(1);
    expect(ledger.expiring).toBe(true);
    // A new message starts a new ledger.
    expect(new SlackStreamMessageLedger().expiring).toBe(false);
  });
});
