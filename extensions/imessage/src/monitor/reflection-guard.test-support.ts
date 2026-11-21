import { describe, expect, it } from "vitest";
import { detectReflectedContent } from "./reflection-guard.js";

describe("detectReflectedContent", () => {
  it.each([
    ["", "empty text"],
    ["Hey, what's the weather today?", "normal user text"],
    ["Please keep `<thinking>debug trace</thinking>` in the example output", "inline code"],
    [
      "User pasted a repro snippet:\n```xml\n<relevant_memories>cached</relevant_memories>\nassistant to=final\n```",
      "fenced code",
    ],
    ["I was thinking about your question", "normal code discussion about thinking"],
    ["I sent a <final draft, see below", "partial tag"],
    ["This is a <thought experiment I ran", "unclosed thought tag"],
  ])("ignores %s (%s)", (text) => {
    expect(detectReflectedContent(text)).toStrictEqual({ isReflection: false, matchedLabels: [] });
  });

  it.each([
    ["NO_REPLY +#+#+#+# <thinking>step</thinking> assistant to=final", "internal-separator"],
    ["some text assistant to=final rest", "assistant-role-marker"],
    ["<thinking>internal reasoning</thinking>", "thinking-tag"],
    ["<thought>secret</thought>", "thinking-tag"],
    ["<antml:think>secret</antml:think>visible", "thinking-tag"],
    ["<mm:think>secret</mm:think>visible", "thinking-tag"],
    ["<relevant_memories>data</relevant_memories>", "relevant-memories-tag"],
    ["<final>visible</final>", "final-tag"],
    [
      "```xml\n<thinking>inside code</thinking>\n```\n\nassistant to=final",
      "assistant-role-marker",
    ],
    ["Here is my <final answer>", "final-tag"],
    ["ACP error (ACP_SESSION_INIT_FAILED): ACP metadata is missing for agent:codex", "acp-error"],
    [
      "⚠️ Missing API key for OpenAI on the gateway. Use `openai/gpt-5.5` with the Codex OAuth profile, or set `OPENAI_API_KEY` for direct OpenAI API-key runs.",
      "gateway-missing-api-key",
    ],
  ] satisfies [string, string][])("detects %s", (text, label) => {
    const result = detectReflectedContent(text);
    expect(result.isReflection).toBe(true);
    expect(result.matchedLabels).toContain(label);
  });

  it("returns multiple matched labels for combined markers", () => {
    const result = detectReflectedContent(
      "NO_REPLY +#+#+# <thinking>step</thinking> assistant to=final",
    );
    expect(result.isReflection).toBe(true);
    expect(result.matchedLabels.length).toBeGreaterThanOrEqual(3);
  });
});
