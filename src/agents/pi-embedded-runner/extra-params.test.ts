import { describe, expect, it } from "vitest";
import { needsRoleTransformation, transformDeveloperRole } from "./extra-params.js";

describe("needsRoleTransformation", () => {
  it("returns true for DeepSeek models", () => {
    expect(needsRoleTransformation("openrouter", "deepseek/deepseek-chat")).toBe(true);
    expect(needsRoleTransformation("custom", "deepseek-coder")).toBe(true);
    expect(needsRoleTransformation("deepseek", "deepseek-chat-v3")).toBe(true);
    // Case insensitivity check
    expect(needsRoleTransformation("openrouter", "DeepSeek-R1")).toBe(true);
    expect(needsRoleTransformation("openrouter", "DEEPSEEK-LLM")).toBe(true);
  });

  it("returns false for OpenAI provider", () => {
    expect(needsRoleTransformation("openai", "gpt-4o")).toBe(false);
    expect(needsRoleTransformation("openai", "gpt-4")).toBe(false);
    expect(needsRoleTransformation("openai", "o1")).toBe(false);
    expect(needsRoleTransformation("openai", "o3-mini")).toBe(false);
  });

  it("returns false for Anthropic provider", () => {
    expect(needsRoleTransformation("anthropic", "claude-3-5-sonnet")).toBe(false);
    expect(needsRoleTransformation("anthropic", "claude-3-opus")).toBe(false);
  });

  it("returns false for Google provider", () => {
    expect(needsRoleTransformation("google", "gemini-pro")).toBe(false);
    expect(needsRoleTransformation("google", "gemini-ultra")).toBe(false);
  });

  it("returns false for unknown providers (safe default)", () => {
    expect(needsRoleTransformation("unknown", "some-model")).toBe(false);
    expect(needsRoleTransformation("custom", "custom-model")).toBe(false);
    expect(needsRoleTransformation("", "model")).toBe(false);
  });
});

describe("transformDeveloperRole", () => {
  it("transforms developer role to system role", () => {
    const messages = [
      { role: "developer", content: "You are a helpful assistant." },
      { role: "user", content: "Hello!" },
    ];
    const result = transformDeveloperRole(messages);
    expect(result[0].role).toBe("system");
    expect(result[0].content).toBe("You are a helpful assistant.");
    expect(result[1].role).toBe("user");
  });

  it("handles empty messages array", () => {
    const result = transformDeveloperRole([]);
    expect(result).toEqual([]);
  });

  it("preserves other roles", () => {
    const messages = [
      { role: "system", content: "System prompt" },
      { role: "user", content: "User message" },
      { role: "assistant", content: "Assistant response" },
    ];
    const result = transformDeveloperRole(messages);
    expect(result[0].role).toBe("system");
    expect(result[1].role).toBe("user");
    expect(result[2].role).toBe("assistant");
  });

  it("handles multiple developer messages", () => {
    const messages = [
      { role: "developer", content: "First instruction" },
      { role: "developer", content: "Second instruction" },
      { role: "user", content: "Hello" },
    ];
    const result = transformDeveloperRole(messages);
    expect(result[0].role).toBe("system");
    expect(result[1].role).toBe("system");
    expect(result[2].role).toBe("user");
  });
});
