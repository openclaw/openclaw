import { describe, expect, it } from "vitest";
import { buildAnthropicCliBackend } from "./cli-backend.js";

const TOOLING_PROMPT = [
  "## Tooling",
  "Tools policy-filtered. Names case-sensitive; call exact.",
  "- read: Read files",
  "- message: Message/channel actions",
  "- memory_get",
  "- native_only",
  "The AGENTS.md Tools section guides usage; it never grants availability.",
  "",
  "## Messaging",
  "- Current source visible reply MUST use `message(action=send)`; final text is private.",
  "",
].join("\n");

const backend = buildAnthropicCliBackend();

function transformPrompt(systemPrompt: string, openClawMcpToolNames?: readonly string[]) {
  return backend.transformSystemPrompt?.({
    provider: "claude-cli",
    modelId: "claude-test-model",
    modelDisplay: "anthropic/claude-test-model",
    systemPrompt,
    openClawMcpToolNames,
  });
}

describe("Claude CLI tool naming guidance", () => {
  it("states registered names in Tooling and drops name-only entries Claude Code lists", () => {
    const prompt = transformPrompt(TOOLING_PROMPT, ["read", "message", "memory_get"]);

    expect(prompt?.split("\n").slice(0, 8)).toEqual([
      "## Tooling",
      "For OpenClaw tools, call `mcp__openclaw__<name>`; the bare Tooling labels are not callable. Deferred: ToolSearch `select:mcp__openclaw__<name>` first.",
      "Tool-only replies: `mcp__openclaw__message(action=send)`. Native `SendMessage`/`PushNotification` cannot deliver OpenClaw replies.",
      "Tools policy-filtered. Names case-sensitive; call exact.",
      "- read: Read files",
      "- message: Message/channel actions",
      "- native_only",
      "The AGENTS.md Tools section guides usage; it never grants availability.",
    ]);
    expect(prompt?.endsWith(TOOLING_PROMPT.slice(TOOLING_PROMPT.indexOf("\n## Messaging")))).toBe(
      true,
    );
  });

  it("appends the mapping to prompts without a Tooling section", () => {
    const prompt = "You are a personal assistant running inside OpenClaw.";

    expect(transformPrompt(prompt, ["read"])).toBe(
      `${prompt}\n\n## OpenClaw tool names in Claude Code\nFor OpenClaw tools, call \`mcp__openclaw__<name>\`; the bare Tooling labels are not callable. Deferred: ToolSearch \`select:mcp__openclaw__<name>\` first.\n`,
    );
  });

  it.each([{ tools: undefined }, { tools: [] }])(
    "leaves prompts unchanged without OpenClaw MCP tools (%j)",
    ({ tools }) => {
      expect(transformPrompt(TOOLING_PROMPT, tools)).toBe(TOOLING_PROMPT);
    },
  );

  it("omits message delivery guidance when only other OpenClaw MCP tools are exposed", () => {
    const prompt = transformPrompt(TOOLING_PROMPT, ["read"]);

    expect(prompt).toContain("ToolSearch `select:mcp__openclaw__<name>`");
    expect(prompt).not.toContain("mcp__openclaw__message");
    expect(prompt).not.toContain("SendMessage");
  });

  it("does not duplicate guidance already present in the system prompt", () => {
    const once = transformPrompt(TOOLING_PROMPT, ["message"]);

    expect(once).toBeTypeOf("string");
    if (typeof once !== "string") {
      throw new Error("Claude CLI did not produce a transformed system prompt");
    }
    expect(transformPrompt(once, ["message"])).toBe(once);
  });

  it.each(["", "   \n"])("leaves an empty system prompt unchanged (%j)", (prompt) => {
    expect(transformPrompt(prompt, ["message"])).toBe(prompt);
  });
});
