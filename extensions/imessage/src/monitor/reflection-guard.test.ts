// Imessage tests cover reflection guard plugin behavior.
import { describe, expect, it } from "vitest";
import { detectReflectedContent } from "./reflection-guard.js";

describe("detectReflectedContent", () => {
  it("returns false for empty text", () => {
    expect(detectReflectedContent("").isReflection).toBe(false);
  });

  it("returns false for normal user text", () => {
    const result = detectReflectedContent("Hey, what's the weather today?");
    expect(result.isReflection).toBe(false);
    expect(result.matchedLabels).toStrictEqual([]);
  });

  it("detects +#+#+#+# separator pattern", () => {
    const result = detectReflectedContent("NO_REPLY +#+#+#+#+#+assistant to=final");
    expect(result.isReflection).toBe(true);
    expect(result.matchedLabels).toContain("internal-separator");
  });

  it("detects assistant to=final marker", () => {
    const result = detectReflectedContent("some text assistant to=final rest");
    expect(result.isReflection).toBe(true);
    expect(result.matchedLabels).toContain("assistant-role-marker");
  });

  it("detects <thinking> tags", () => {
    const result = detectReflectedContent("<thinking>internal reasoning</thinking>");
    expect(result.isReflection).toBe(true);
    expect(result.matchedLabels).toContain("thinking-tag");
  });

  it("detects <thought> tags", () => {
    const result = detectReflectedContent("<thought>secret</thought>");
    expect(result.isReflection).toBe(true);
    expect(result.matchedLabels).toContain("thinking-tag");
  });

  it("detects <relevant_memories> tags", () => {
    const result = detectReflectedContent("<relevant_memories>data</relevant_memories>");
    expect(result.isReflection).toBe(true);
    expect(result.matchedLabels).toContain("relevant-memories-tag");
  });

  it("detects <final> tags", () => {
    const result = detectReflectedContent("<final>visible</final>");
    expect(result.isReflection).toBe(true);
    expect(result.matchedLabels).toContain("final-tag");
  });

  it("returns multiple matched labels for combined markers", () => {
    const text = "NO_REPLY +#+#+#+# <thinking>step</thinking> assistant to=final";
    const result = detectReflectedContent(text);
    expect(result.isReflection).toBe(true);
    expect(result.matchedLabels.length).toBeGreaterThanOrEqual(3);
  });

  it("ignores reflection markers inside inline code", () => {
    const result = detectReflectedContent(
      "Please keep `<thinking>debug trace</thinking>` in the example output",
    );
    expect(result.isReflection).toBe(false);
    expect(result.matchedLabels).toStrictEqual([]);
  });

  it("ignores reflection markers inside fenced code blocks", () => {
    const result = detectReflectedContent(
      [
        "User pasted a repro snippet:",
        "```xml",
        "<relevant_memories>cached</relevant_memories>",
        "assistant to=final",
        "```",
      ].join("\n"),
    );
    expect(result.isReflection).toBe(false);
    expect(result.matchedLabels).toStrictEqual([]);
  });

  it("still flags markers that appear outside code blocks", () => {
    const result = detectReflectedContent(
      ["```xml", "<thinking>inside code</thinking>", "```", "", "assistant to=final"].join("\n"),
    );
    expect(result.isReflection).toBe(true);
    expect(result.matchedLabels).toContain("assistant-role-marker");
  });

  it("does not flag normal code discussion about thinking", () => {
    const result = detectReflectedContent("I was thinking about your question");
    expect(result.isReflection).toBe(false);
  });

  it("flags '<final answer>' as reflection when it forms a complete tag", () => {
    const result = detectReflectedContent("Here is my <final answer>");
    expect(result.isReflection).toBe(true);
  });

  it("does not flag partial tag without closing bracket", () => {
    const result = detectReflectedContent("I sent a <final draft, see below");
    expect(result.isReflection).toBe(false);
  });

  it("does not flag '<thought experiment>' phrase without closing bracket", () => {
    const result = detectReflectedContent("This is a <thought experiment I ran");
    expect(result.isReflection).toBe(false);
  });

  it("detects reflected ACP channel error replies", () => {
    const result = detectReflectedContent(
      "ACP error (ACP_SESSION_INIT_FAILED): ACP metadata is missing for agent:codex",
    );
    expect(result.isReflection).toBe(true);
    expect(result.matchedLabels).toContain("acp-error");
  });

  it("detects reflected gateway auth failure replies", () => {
    const result = detectReflectedContent(
      "⚠️ Missing API key for OpenAI on the gateway. Use `openai/gpt-5.5` with the Codex OAuth profile, or set `OPENAI_API_KEY` for direct OpenAI API-key runs.",
    );
    expect(result.isReflection).toBe(true);
    expect(result.matchedLabels).toContain("gateway-missing-api-key");
  });

  it("detects reflected localized gateway auth failure replies", () => {
    for (const text of [
      "⚠️ Gateway 缺少 OpenAI API Key。请使用带 OpenAI OAuth profile 的 `openai/gpt-5.5`，或为直接 OpenAI API Key 运行设置 `OPENAI_API_KEY`。",
      "⚠️ Gateway 缺少 OpenAI API Key。請使用帶 OpenAI OAuth profile 的 `openai/gpt-5.5`，或為直接 OpenAI API Key 執行設定 `OPENAI_API_KEY`。",
      '⚠️ 缺少 provider "openai" 的 API Key。请运行 `openclaw doctor --fix` 修复过期的 OpenAI 模型/会话路由；如果 doctor 提示，请重启 gateway 后再试。',
      '⚠️ 缺少 provider "openai" 的 API Key。請執行 `openclaw doctor --fix` 修復過期的 OpenAI 模型/工作階段路由；如果 doctor 提示，請重新啟動 gateway 後再試。',
    ]) {
      const result = detectReflectedContent(text);
      expect(result.isReflection).toBe(true);
      expect(result.matchedLabels).toContain("gateway-missing-api-key");
    }
  });
});
