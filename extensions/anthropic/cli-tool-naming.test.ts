import { describe, expect, it } from "vitest";
import { buildAnthropicCliBackend } from "./cli-backend.js";
import { appendClaudeCliToolNamingGuidance } from "./cli-tool-naming.js";

const CLAUDE_CLI_TOOL_NAMING_HEADING = "## OpenClaw tool names in Claude Code";

const TOOLING_PROMPT = [
  "## Tooling",
  "Tools policy-filtered. Names case-sensitive; call exact.",
  "- message: Send a message to the current source conversation.",
  "",
  "## Messaging",
  "- Current source visible reply MUST use `message(action=send)`; final text is private.",
].join("\n");

describe("appendClaudeCliToolNamingGuidance", () => {
  it("maps the short OpenClaw tool names onto Claude's mcp__openclaw__ registrations", () => {
    const prompt = appendClaudeCliToolNamingGuidance(TOOLING_PROMPT);

    expect(prompt.startsWith(TOOLING_PROMPT)).toBe(true);
    expect(prompt).toContain(CLAUDE_CLI_TOOL_NAMING_HEADING);
    expect(prompt).toContain("`message` => `mcp__openclaw__message`");
    expect(prompt).toContain("ToolSearch `select:mcp__openclaw__<name>`");
    expect(prompt).toContain("`mcp__openclaw__message(action=send)`");
    expect(prompt.endsWith("\n")).toBe(true);
  });

  it("appends the section once", () => {
    const once = appendClaudeCliToolNamingGuidance(TOOLING_PROMPT);
    const twice = appendClaudeCliToolNamingGuidance(once);

    expect(twice).toBe(once);
    expect(twice.split(CLAUDE_CLI_TOOL_NAMING_HEADING)).toHaveLength(2);
  });

  it("leaves empty prompts alone", () => {
    expect(appendClaudeCliToolNamingGuidance("")).toBe("");
    expect(appendClaudeCliToolNamingGuidance("   \n")).toBe("   \n");
  });
});

describe("Claude CLI backend system prompt transform", () => {
  it("applies the tool naming overlay to every built system prompt", () => {
    const backend = buildAnthropicCliBackend();

    const transformed = backend.transformSystemPrompt?.({
      provider: "claude-cli",
      modelId: "claude-opus-4-8",
      modelDisplay: "anthropic/claude-opus-4-8",
      systemPrompt: TOOLING_PROMPT,
    });

    expect(transformed).toBe(appendClaudeCliToolNamingGuidance(TOOLING_PROMPT));
    expect(transformed).toContain("`mcp__openclaw__message(action=send)`");
  });
});
