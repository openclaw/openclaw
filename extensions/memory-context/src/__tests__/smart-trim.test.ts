import { describe, it, expect } from "vitest";
import { smartTrim, isRecalledContext, type MessageLike } from "../core/smart-trim.js";

const est = (msg: MessageLike) => {
  const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? "");
  return Math.max(1, Math.ceil(text.length / 3));
};
function makeMessages(n: number, tokensPer = 100): MessageLike[] {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `msg${i} ${"x".repeat(tokensPer * 3)}`,
  }));
}
describe("smart-trim", () => {
  it("no trim when under safeLimit", () => {
    const msgs = makeMessages(5, 10);
    const r = smartTrim(msgs, "test", {
      protectedRecent: 6,
      safeLimit: 99999,
      estimateTokens: est,
    });
    expect(r.didTrim).toBe(false);
    expect(r.kept).toHaveLength(5);
  });
  it("protects system prompt", () => {
    const msgs: MessageLike[] = [
      { role: "system", content: "sys " + "x".repeat(300) },
      ...makeMessages(20, 50),
    ];
    const r = smartTrim(msgs, "msg0", { protectedRecent: 4, safeLimit: 500, estimateTokens: est });
    expect(r.kept.some((m) => m.role === "system")).toBe(true);
  });
  it("protects last N messages", () => {
    const msgs = makeMessages(20, 50);
    const r = smartTrim(msgs, "msg0", { protectedRecent: 4, safeLimit: 500, estimateTokens: est });
    const lastFour = msgs.slice(-4);
    for (const m of lastFour) expect(r.kept).toContain(m);
  });
  it("trims low BM25 relevance first", () => {
    const pad = "x".repeat(600);
    const msgs: MessageLike[] = [
      { role: "user", content: "discuss stripe webhook integration" },
      { role: "assistant", content: "stripe webhook handler code" },
      { role: "user", content: `deployment docker compose ${pad}` },
      { role: "assistant", content: `docker compose production ${pad}` },
      { role: "user", content: "stripe error handling webhooks" },
      { role: "assistant", content: "error handling webhook endpoint" },
    ];
    const shortTotal = est(msgs[0]) + est(msgs[1]) + est(msgs[4]) + est(msgs[5]);
    const r = smartTrim(msgs, "stripe webhook", {
      protectedRecent: 2,
      safeLimit: shortTotal + 5,
      estimateTokens: est,
    });
    expect(r.didTrim).toBe(true);
    const keptTexts = r.kept.map((m) => (typeof m.content === "string" ? m.content : ""));
    expect(keptTexts.some((t) => t.includes("docker"))).toBe(false);
  });
  it("time-order fallback when BM25 not enough", () => {
    const msgs = makeMessages(30, 50);
    const r = smartTrim(msgs, "irrelevant", {
      protectedRecent: 4,
      safeLimit: 800,
      estimateTokens: est,
    });
    expect(r.didTrim).toBe(true);
    expect(r.trimmed.length).toBeGreaterThan(0);
  });
  it("tool_use/toolResult pairing", () => {
    const msgs: MessageLike[] = [
      { role: "user", content: "old " + "x".repeat(300) },
      {
        role: "assistant",
        content: [
          { type: "text", text: "check" },
          { type: "tool_use", id: "t1", name: "read" },
        ],
      },
      { role: "toolResult", content: "result " + "x".repeat(300) },
      { role: "user", content: "current stripe question" },
      { role: "assistant", content: "stripe answer" },
    ];
    const r = smartTrim(msgs, "stripe", {
      protectedRecent: 2,
      safeLimit: est(msgs[3]) + est(msgs[4]) + 50,
      estimateTokens: est,
    });
    const hasToolUse = r.kept.some(
      (m) =>
        Array.isArray(m.content) && (m.content as any[]).some((b: any) => b.type === "tool_use"),
    );
    const hasToolResult = r.kept.some((m) => m.role === "toolResult");
    if (hasToolUse) expect(hasToolResult).toBe(true);
    if (!hasToolUse) expect(hasToolResult).toBe(false);
  });
  it("recalled-context not in trimmed", () => {
    const msgs: MessageLike[] = [
      { role: "user", content: '<recalled-context source="memory-context">old</recalled-context>' },
      ...makeMessages(10, 50),
    ];
    const r = smartTrim(msgs, "test", { protectedRecent: 4, safeLimit: 500, estimateTokens: est });
    expect(r.trimmed.every((m) => !isRecalledContext(m))).toBe(true);
  });
  it("empty messages ok", () => {
    const r = smartTrim([], "test", { protectedRecent: 6, safeLimit: 100, estimateTokens: est });
    expect(r.didTrim).toBe(false);
  });
  it("idempotent", () => {
    const msgs = makeMessages(20, 50);
    const cfg = { protectedRecent: 4, safeLimit: 500, estimateTokens: est };
    const r1 = smartTrim(msgs, "test", cfg);
    const r2 = smartTrim(r1.kept, "test", cfg);
    expect(r2.didTrim).toBe(false);
  });
});
