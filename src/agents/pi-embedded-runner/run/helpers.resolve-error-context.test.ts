import { describe, expect, it } from "vitest";
import { resolveActiveErrorContext, resolveAssistantForFailover } from "./helpers.js";

describe("resolveActiveErrorContext", () => {
  it("returns the current provider/model", () => {
    const result = resolveActiveErrorContext({
      provider: "deepseek",
      model: "deepseek-chat",
    });
    expect(result).toEqual({ provider: "deepseek", model: "deepseek-chat" });
  });

  it("prefers assistant provider/model when the failing attempt reports them", () => {
    const result = resolveActiveErrorContext({
      provider: "openai",
      model: "gpt-5.4",
      assistant: {
        provider: "openai",
        model: "gpt-5.4-codex",
      },
    });

    expect(result).toEqual({ provider: "openai", model: "gpt-5.4-codex" });
  });

  it("ignores the embedded PI harness provider when the model provider is known", () => {
    const result = resolveActiveErrorContext({
      provider: "openrouter",
      model: "openai/gpt-5.4",
      assistant: {
        provider: "pi",
        model: "pi",
      },
    });

    expect(result).toEqual({ provider: "openrouter", model: "openai/gpt-5.4" });
  });
});

describe("resolveAssistantForFailover", () => {
  it("prefers the current attempt assistant", () => {
    const currentAttemptAssistant = {
      provider: "deepseek",
      model: "deepseek-chat",
    };
    const sessionLastAssistant = {
      provider: "openai-codex",
      model: "gpt-5.4",
    };

    expect(
      resolveAssistantForFailover({
        provider: "deepseek",
        model: "deepseek-chat",
        currentAttemptAssistant,
        sessionLastAssistant,
      }),
    ).toBe(currentAttemptAssistant);
  });

  it("uses session history when compaction removed the current same-candidate assistant", () => {
    const sessionLastAssistant = {
      provider: "deepseek",
      model: "deepseek-chat",
    };

    expect(
      resolveAssistantForFailover({
        provider: "deepseek",
        model: "deepseek-chat",
        sessionLastAssistant,
      }),
    ).toBe(sessionLastAssistant);
  });

  it("does not reuse a stale assistant from a different fallback candidate", () => {
    const sessionLastAssistant = {
      provider: "openai-codex",
      model: "gpt-5.4",
    };

    expect(
      resolveAssistantForFailover({
        provider: "deepseek",
        model: "deepseek-chat",
        sessionLastAssistant,
      }),
    ).toBeUndefined();
  });
});
