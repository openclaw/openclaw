import { describe, expect, it } from "vitest";
import { buildAnthropicCliBackend } from "./cli-backend.js";

const TOOLING_PROMPT = [
  "## Tooling",
  "Tools policy-filtered. Names case-sensitive; call exact.",
  "- message: Send a message to the current source conversation.",
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
  it("puts the registered MCP name before the exact-name Tooling instructions", () => {
    const prompt = transformPrompt(TOOLING_PROMPT, ["message"]);

    const exactNameInstruction = prompt?.indexOf("Names case-sensitive; call exact.") ?? -1;
    const registeredNameGuidance = prompt?.indexOf("mcp__openclaw__<name>") ?? -1;
    expect(exactNameInstruction).toBeGreaterThanOrEqual(0);
    expect(registeredNameGuidance).toBeGreaterThanOrEqual(0);
    expect(registeredNameGuidance).toBeLessThan(exactNameInstruction);
    expect(prompt).toContain("bare Tooling labels are not callable");
  });

  it("preserves Tooling text and supplies registered message delivery and discovery names", () => {
    const prompt = transformPrompt(TOOLING_PROMPT, ["message"]);

    expect(prompt?.startsWith("## Tooling\n")).toBe(true);
    expect(prompt).toContain(TOOLING_PROMPT.slice("## Tooling\n".length));
    expect(prompt).toContain("`mcp__openclaw__<name>`");
    expect(prompt).toContain("ToolSearch `select:mcp__openclaw__<name>`");
    expect(prompt).toContain("`mcp__openclaw__message(action=send)`");
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
