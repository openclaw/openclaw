import { describe, expect, it } from "vitest";
import {
  classifyProviderHeuristic,
  classifyRiskLevel,
  createIntentRouterTool,
} from "./intent-router.js";

describe("automation intent router tool", () => {
  it("classifies coding intent to codex", () => {
    expect(classifyProviderHeuristic("請幫我 refactor auth module")).toBe("codex");
  });

  it("classifies high risk keywords", () => {
    expect(classifyRiskLevel("請直接 deploy 到 production")).toBe("high");
  });

  it("returns fixed-format error when message is missing", async () => {
    const tool = createIntentRouterTool({} as any);
    await expect(tool.execute("id", {})).rejects.toThrow("error_code=INTENT_INPUT_INVALID");
  });

  it("returns zh-tw reasoning text", async () => {
    const tool = createIntentRouterTool({} as any);
    const result = await tool.execute("id", { message: "請分析這個策略" });
    const payload = result.details as { reasoning?: string };
    expect(payload.reasoning).toContain("分類結果：");
  });
});
