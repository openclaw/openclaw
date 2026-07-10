// CJK text is ~1 token per character in real tokenizers; the raw chars/4
// heuristic under-counted CJK sessions ~3-4x so keepRecentTokens kept far
// more than budgeted (#103930).
import { describe, expect, it } from "vitest";
import { estimateTokens } from "./compaction.js";

type EstimateInput = Parameters<typeof estimateTokens>[0];

describe("estimateTokens CJK weighting", () => {
  it("weights CJK characters as ~1 token each", () => {
    const cjk = "深度学习模型的上下文窗口管理策略".repeat(10); // 160 CJK chars
    const tokens = estimateTokens({ role: "user", content: cjk } as EstimateInput);
    // 160 chars weighted at 4 chars each -> ~160 tokens (raw chars/4 gave 40).
    expect(tokens).toBe(160);
  });

  it("keeps pure Latin estimates unchanged", () => {
    const latin = "a".repeat(160);
    const tokens = estimateTokens({ role: "user", content: latin } as EstimateInput);
    expect(tokens).toBe(40);
  });

  it("weights assistant text blocks the same way", () => {
    const tokens = estimateTokens({
      role: "assistant",
      content: [{ type: "text", text: "요약을 계속 진행하겠습니다".repeat(10) }],
    } as EstimateInput);
    const cjkChars = "요약을 계속 진행하겠습니다".repeat(10);
    const hangul = (cjkChars.match(/[가-힯]/g) ?? []).length;
    expect(tokens).toBe(Math.ceil((cjkChars.length + hangul * 3) / 4));
  });
});
