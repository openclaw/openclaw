// Qa Lab tests cover reply failure plugin behavior.
import { describe, expect, it } from "vitest";
import { extractQaFailureReplyText, extractQaVisibleReplyLeakText } from "./reply-failure.js";

describe("extractQaFailureReplyText", () => {
  it("returns undefined for normal assistant replies", () => {
    expect(
      extractQaFailureReplyText("Yes, precious. The build is green and a little cursed."),
    ).toBe(undefined);
  });

  it("does not classify ordinary localized warning replies as failures", () => {
    expect(extractQaFailureReplyText("⚠️ 缺少足够信息判断这个问题。")).toBe(undefined);
  });

  it("classifies the generic external fallback reply as a failure", () => {
    expect(
      extractQaFailureReplyText(
        "⚠️ Something went wrong while processing your request. Please try again, or use /new to start a fresh session.",
      ),
    ).toContain("Something went wrong while processing your request.");
  });

  it("classifies localized generic external fallback replies as failures", () => {
    for (const text of [
      "⚠️ 处理你的请求时出了问题。请重试，或使用 /new 开始一个新会话。",
      "⚠️ 處理你的請求時發生問題。請重試，或使用 /new 開始新工作階段。",
    ]) {
      expect(extractQaFailureReplyText(text)).toBe(text);
    }
  });

  it("classifies explicit provider auth guidance as a failure", () => {
    expect(
      extractQaFailureReplyText(
        '⚠️ No API key found for provider "openai". You are authenticated with OpenAI Codex OAuth. Use openai/gpt-5.5 with the Codex OAuth profile, or set OPENAI_API_KEY for direct OpenAI API access.',
      ),
    ).toContain('No API key found for provider "openai".');
  });

  it("classifies curated missing-key guidance as a failure", () => {
    expect(
      extractQaFailureReplyText(
        "⚠️ Missing API key for OpenAI on the gateway. Use `openai/gpt-5.5` with the Codex OAuth profile, or set `OPENAI_API_KEY`, then try again.",
      ),
    ).toContain("Missing API key for OpenAI on the gateway.");
  });

  it("classifies localized runtime failure guidance as failures", () => {
    for (const text of [
      "⚠️ Agent 在回复前失败：模型切换未能完成。请求的模型可能暂时不可用。请稍后重试。",
      "⚠️ Agent 在回覆前失敗：模型切換未能完成。請求的模型可能暫時不可用。請稍後重試。",
      "⚠️ Gateway 上的模型登录已过期（openai）。请使用 `openclaw models auth login --provider openai` 重新认证后再试。",
      "⚠️ Gateway 上的模型登入失敗（openai）。請重試。如果持續發生，請使用 `openclaw models auth login --provider openai` 重新認證。",
      "⚠️ Gateway 缺少 OpenAI API Key。请使用带 OpenAI OAuth profile 的 `openai/gpt-5.5`，或为直接 OpenAI API Key 运行设置 `OPENAI_API_KEY`。",
      '⚠️ 缺少 provider "openai" 的 API Key。請執行 `openclaw doctor --fix` 修復過期的 OpenAI 模型/工作階段路由。',
      "⚠️ 上下文超出限制：这次请求对当前模型来说太长了。请缩短消息，或换用更大上下文的模型。",
      "⚠️ 上下文过大，自动压缩未能恢复本轮。请重试，使用 /compact，或使用 /new 开始一个新会话。",
      "⚠️ 上下文過大，自動壓縮未能恢復本輪。請重試，使用 /compact，或使用 /new 開始新工作階段。",
    ]) {
      expect(extractQaFailureReplyText(text)).toBe(text);
    }
  });

  it("classifies leaked codex harness coordination chatter as a failure", () => {
    expect(
      extractQaFailureReplyText("checking thread context; then post a tight progress reply here."),
    ).toContain("checking thread context");
  });
});

describe("extractQaVisibleReplyLeakText", () => {
  it("returns undefined for normal visible replies", () => {
    expect(extractQaVisibleReplyLeakText("QA_LEAK_OK")).toBe(undefined);
  });

  it("detects coordination-nudge leak text", () => {
    expect(
      extractQaVisibleReplyLeakText(
        "thread context thin; posting a coordination nudge, not inventing status.",
      ),
    ).toContain("thread context thin");
  });
});
