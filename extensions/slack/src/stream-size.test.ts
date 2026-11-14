import type { AnyChunk } from "@slack/types";
import { describe, expect, it } from "vitest";
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
  it("counts UTF-8 bytes, the unit Slack's size check uses", () => {
    const ledger = new SlackStreamMessageLedger();
    ledger.record({ text: "🧠 ab" });
    expect(ledger.textSize).toBe(7);
    ledger.record({ chunks: [task("a", "字")] });
    expect(ledger.rowSize).toBe(3);
    ledger.record({ text: undefined });
    expect(ledger.size).toBe(10);
  });

  it("replaces titles and the plan title, appends details, output and text", () => {
    const ledger = new SlackStreamMessageLedger();
    ledger.record({
      chunks: [{ type: "plan_update", title: "Thinking" }, task("a", "12345", { details: "dd" })],
    });
    expect(ledger.rowSize).toBe(8 + 5 + 2 * 2);
    expect(ledger.taskCount).toBe(1);
    ledger.record({
      text: "hello",
      chunks: [
        { type: "plan_update", title: "Thought for 3s" },
        task("a", "1234567890", { details: "e", output: "+1 −2", status: "complete" }),
      ],
    });
    // Title 5 -> 10 counts once; details 2 + 1 and output 7 bytes (the minus sign is 3) weigh double.
    expect(ledger.rowSize).toBe(14 + 10 + 2 * 3 + 2 * 7);
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
    expect(ledger.size).toBe(3);
    expect(copy.size).toBe(10);
    expect(ledger.isEmpty).toBe(false);
    expect(new SlackStreamMessageLedger().isEmpty).toBe(true);
  });
});

describe("planSlackStreamUpdateFit", () => {
  it("uses the measured budgets by default: 6,000 weighted bytes of rows, 9,000 in all", () => {
    const rows = new SlackStreamMessageLedger();
    rows.record({ chunks: [task("a", "x".repeat(5_990))] });
    expect([
      ...planSlackStreamUpdateFit(rows, { chunks: [task("b", "y".repeat(10))] }).admittedTaskIds,
    ]).toEqual(["b"]);
    expect([
      ...planSlackStreamUpdateFit(rows, { chunks: [task("b", "y".repeat(11))] }).deferredTaskIds,
    ]).toEqual(["b"]);
    const text = new SlackStreamMessageLedger();
    text.record({ text: "a".repeat(8_990) });
    expect(planSlackStreamUpdateFit(text, { text: "b".repeat(10) }).textFits).toBe(true);
    expect(planSlackStreamUpdateFit(text, { text: "b".repeat(11) }).textFits).toBe(false);
  });

  it("admits new rows in order up to the row budget and defers the rest", () => {
    const ledger = new SlackStreamMessageLedger();
    ledger.record({ chunks: [{ type: "plan_update", title: "Thinking" }] });
    const chunks = Array.from({ length: 30 }, (_, index) => card(index + 1));
    const fit = planSlackStreamUpdateFit(ledger, { chunks });
    // 24 cards of 244 bytes plus the 8-byte title stay under 6,000; the 25th would not.
    expect(fit.fits).toBe(false);
    expect(fit.textFits).toBe(true);
    expect([...fit.admittedTaskIds]).toEqual(
      Array.from({ length: 24 }, (_, index) => `reasoning_${index + 1}`),
    );
    expect([...fit.deferredTaskIds]).toEqual(
      Array.from({ length: 6 }, (_, index) => `reasoning_${index + 25}`),
    );
  });

  it("keeps deferring once a row is deferred so the plan stays in order", () => {
    const ledger = new SlackStreamMessageLedger();
    ledger.record({ chunks: Array.from({ length: 24 }, (_, index) => card(index + 1)) });
    const fit = planSlackStreamUpdateFit(ledger, {
      chunks: [card(25), task("tool_1", "🛠️ Bash"), card(26)],
    });
    expect([...fit.admittedTaskIds]).toEqual([]);
    expect([...fit.deferredTaskIds]).toEqual(["reasoning_25", "tool_1", "reasoning_26"]);
  });

  it("always applies updates to rows already on the message", () => {
    const ledger = new SlackStreamMessageLedger();
    ledger.record({ chunks: Array.from({ length: 24 }, (_, index) => card(index + 1)) });
    const fit = planSlackStreamUpdateFit(ledger, {
      chunks: [
        { type: "plan_update", title: "Thought for 9s" },
        task("reasoning_24", "🧠 longer final text", { status: "complete" }),
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
    ledger.record({ chunks: Array.from({ length: 24 }, (_, index) => card(index + 1)) });
    const answer = "a".repeat(3_400);
    expect(planSlackStreamUpdateFit(ledger, { text: answer }).textFits).toBe(false);
    expect(planSlackStreamUpdateFit(ledger, { text: "a".repeat(3_000) }).textFits).toBe(true);
    // Text counts before new rows: the answer takes the space, the row is deferred.
    const fit = planSlackStreamUpdateFit(ledger, { text: "a".repeat(3_000), chunks: [card(25)] });
    expect(fit.textFits).toBe(true);
    expect([...fit.deferredTaskIds]).toEqual(["reasoning_25"]);
  });

  it("lets an empty message take the text and a first row regardless of size", () => {
    const fit = planSlackStreamUpdateFit(new SlackStreamMessageLedger(), {
      text: "a".repeat(10_000),
      chunks: [card(1, 250), card(2)],
    });
    expect(fit.textFits).toBe(true);
    expect([...fit.admittedTaskIds]).toEqual(["reasoning_1"]);
    expect([...fit.deferredTaskIds]).toEqual(["reasoning_2"]);
  });
});
