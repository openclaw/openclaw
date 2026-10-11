import { describe, expect, it } from "vitest";
import { buildAnthropicCliBackend } from "./cli-backend.js";

const TOOLING_PROMPT = [
  "## Tooling",
  "- message: Send a message to the current source conversation.",
  "",
  "## Messaging",
  "- Current source visible reply MUST use `message(action=send)`; final text is private.",
  "",
].join("\n");

const backend = buildAnthropicCliBackend();

function transformPrompt(systemPrompt: string) {
  return backend.transformSystemPrompt?.({
    provider: "claude-cli",
    modelId: "claude-test-model",
    modelDisplay: "anthropic/claude-test-model",
    systemPrompt,
  });
}

describe("Claude CLI tool naming guidance", () => {
  it("preserves the prompt prefix and supplies registered message delivery and discovery names", () => {
    const prompt = transformPrompt(TOOLING_PROMPT);

    expect(prompt?.startsWith(TOOLING_PROMPT)).toBe(true);
    expect(prompt).toContain("`message` => `mcp__openclaw__message`");
    expect(prompt).toContain("ToolSearch `select:mcp__openclaw__<name>`");
    expect(prompt).toContain("`mcp__openclaw__message(action=send)`");
  });

  it("does not duplicate guidance already present in the system prompt", () => {
    const once = transformPrompt(TOOLING_PROMPT);

    expect(once).toBeTypeOf("string");
    if (typeof once !== "string") {
      throw new Error("Claude CLI did not produce a transformed system prompt");
    }
    expect(transformPrompt(once)).toBe(once);
  });

  it.each(["", "   \n"])("leaves an empty system prompt unchanged (%j)", (prompt) => {
    expect(transformPrompt(prompt)).toBe(prompt);
  });
});
