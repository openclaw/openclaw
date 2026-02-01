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

  it("returns false for OpenRouter with OpenAI models", () => {
    expect(needsRoleTransformation("openrouter", "openai/gpt-4o")).toBe(false);
    expect(needsRoleTransformation("openrouter", "openai/gpt-4-turbo")).toBe(false);
    expect(needsRoleTransformation("openrouter", "openai/o1")).toBe(false);
  });

  it("returns true for other providers and models by default", () => {
    expect(needsRoleTransformation("anthropic", "claude-sonnet-4")).toBe(true);
    expect(needsRoleTransformation("google", "gemini-2.0-flash")).toBe(true);
    expect(needsRoleTransformation("ollama", "llama3.3")).toBe(true);
    expect(needsRoleTransformation("custom", "mistral-large")).toBe(true);
    expect(needsRoleTransformation("openrouter", "anthropic/claude-sonnet-4")).toBe(true);
    expect(needsRoleTransformation("openrouter", "google/gemini-flash-2.0")).toBe(true);
  });
});

describe("transformDeveloperRole", () => {
  it("converts developer role to system role", () => {
    const context = {
      messages: [
        { role: "developer", content: "You are a helpful assistant" },
        { role: "user", content: "Hello" },
      ],
    };

    const result = transformDeveloperRole(context);

    expect(result.messages).toEqual([
      { role: "system", content: "You are a helpful assistant" },
      { role: "user", content: "Hello" },
    ]);
  });

  it("leaves other roles unchanged", () => {
    const context = {
      messages: [
        { role: "system", content: "You are a helpful assistant" },
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
        { role: "tool", content: "Tool result" },
      ],
    };

    const result = transformDeveloperRole(context);

    expect(result.messages).toEqual([
      { role: "system", content: "You are a helpful assistant" },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
      { role: "tool", content: "Tool result" },
    ]);
  });

  it("handles mixed developer and other roles", () => {
    const context = {
      messages: [
        { role: "developer", content: "Be helpful" },
        { role: "user", content: "Hi" },
        { role: "developer", content: "Also be concise" },
        { role: "assistant", content: "Hello!" },
      ],
    };

    const result = transformDeveloperRole(context);

    expect(result.messages).toEqual([
      { role: "system", content: "Be helpful" },
      { role: "user", content: "Hi" },
      { role: "system", content: "Also be concise" },
      { role: "assistant", content: "Hello!" },
    ]);
  });

  it("handles empty messages array", () => {
    const context = {
      messages: [],
    };

    const result = transformDeveloperRole(context);

    expect(result.messages).toEqual([]);
  });

  it("handles undefined messages", () => {
    const context: { messages?: Array<{ role: string; content: unknown }> } = {};

    const result = transformDeveloperRole(context);

    expect(result.messages).toBeUndefined();
  });

  it("returns same context reference when messages is undefined", () => {
    const context = {};

    const result = transformDeveloperRole(context);

    expect(result).toBe(context);
  });

  it("returns same context reference when messages is empty", () => {
    const context = {
      messages: [],
    };

    const result = transformDeveloperRole(context);

    expect(result).toBe(context);
  });

  it("preserves other context properties", () => {
    const context = {
      messages: [{ role: "developer", content: "Test" }],
      temperature: 0.7,
      maxTokens: 100,
    } as {
      messages: Array<{ role: string; content: unknown }>;
      temperature: number;
      maxTokens: number;
    };

    const result = transformDeveloperRole(context);

    expect(result.temperature).toBe(0.7);
    expect(result.maxTokens).toBe(100);
  });

  it("creates new message objects (does not mutate original)", () => {
    const originalMessage = { role: "developer", content: "Test" };
    const context = {
      messages: [originalMessage],
    };

    const result = transformDeveloperRole(context);

    expect(result.messages![0]).not.toBe(originalMessage);
    expect(originalMessage.role).toBe("developer");
  });
});
