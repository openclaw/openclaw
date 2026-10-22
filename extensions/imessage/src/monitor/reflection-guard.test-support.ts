import { describe, expect, it } from "vitest";
import { detectReflectedContent } from "./reflection-guard.js";

function expectReflection(text: string, label: string) {
  const result = detectReflectedContent(text);
  expect(result.isReflection).toBe(true);
  expect(result.matchedLabels).toContain(label);
}

function expectOrdinaryText(text: string) {
  expect(detectReflectedContent(text)).toStrictEqual({ isReflection: false, matchedLabels: [] });
}

describe("detectReflectedContent", () => {
  it("returns false for empty text", () => {
    expect(detectReflectedContent("").isReflection).toBe(false);
  });

  it("returns false for normal user text", () => {
    expectOrdinaryText("Hey, what's the weather today?");
  });

  it("detects +#+#+#+# separator pattern", () => {
    expectReflection("NO_REPLY +#+#+#+#+#+assistant to=final", "internal-separator");
  });

  it("detects assistant to=final marker", () => {
    expectReflection("some text assistant to=final rest", "assistant-role-marker");
  });

  it.each([
    ["thinking", "internal reasoning", ""],
    ["thought", "secret", ""],
    ["antml:think", "secret", "visible"],
    ["mm:think", "secret", "visible"],
  ])("detects <%s> reasoning tags", (tag, content, suffix) => {
    expectReflection(`<${tag}>${content}</${tag}>${suffix}`, "thinking-tag");
  });

  it("detects <relevant_memories> tags", () => {
    expectReflection("<relevant_memories>data</relevant_memories>", "relevant-memories-tag");
  });

  it("detects <final> tags", () => {
    expectReflection("<final>visible</final>", "final-tag");
  });

  it("returns multiple matched labels for combined markers", () => {
    const text = "NO_REPLY +#+#+#+# <thinking>step</thinking> assistant to=final";
    const result = detectReflectedContent(text);
    expect(result.isReflection).toBe(true);
    expect(result.matchedLabels.length).toBeGreaterThanOrEqual(3);
  });

  it("ignores reflection markers inside inline code", () => {
    expectOrdinaryText("Please keep `<thinking>debug trace</thinking>` in the example output");
  });

  it("ignores reflection markers inside fenced code blocks", () => {
    expectOrdinaryText(
      "User pasted a repro snippet:\n```xml\n<relevant_memories>cached</relevant_memories>\nassistant to=final\n```",
    );
  });

  it("still flags markers that appear outside code blocks", () => {
    expectReflection(
      ["```xml", "<thinking>inside code</thinking>", "```", "", "assistant to=final"].join("\n"),
      "assistant-role-marker",
    );
  });

  it("flags '<final answer>' as reflection when it forms a complete tag", () => {
    expect(detectReflectedContent("Here is my <final answer>").isReflection).toBe(true);
  });

  it.each([
    ["normal code discussion about thinking", "I was thinking about your question"],
    ["partial tag without closing bracket", "I sent a <final draft, see below"],
    ["unclosed '<thought experiment>' phrase", "This is a <thought experiment I ran"],
  ])("does not flag %s", (_name, text) => {
    expect(detectReflectedContent(text).isReflection).toBe(false);
  });

  it("detects reflected ACP channel error replies", () => {
    expectReflection(
      "ACP error (ACP_SESSION_INIT_FAILED): ACP metadata is missing for agent:codex",
      "acp-error",
    );
  });

  it("detects reflected gateway auth failure replies", () => {
    expectReflection(
      "⚠️ Missing API key for OpenAI on the gateway. Use `openai/gpt-5.5` with the Codex OAuth profile, or set `OPENAI_API_KEY` for direct OpenAI API-key runs.",
      "gateway-missing-api-key",
    );
  });
});
