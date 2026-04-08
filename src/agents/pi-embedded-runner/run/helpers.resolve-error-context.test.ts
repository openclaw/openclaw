import { describe, expect, it } from "vitest";
import { resolveActiveErrorContext } from "./helpers.js";

describe("resolveActiveErrorContext", () => {
  it("uses current provider/model when lastAssistant is undefined", () => {
    const result = resolveActiveErrorContext({
      lastAssistant: undefined,
      provider: "deepseek",
      model: "deepseek-chat",
    });
    expect(result).toEqual({ provider: "deepseek", model: "deepseek-chat" });
  });

  it("uses current provider/model even when lastAssistant has different provider", () => {
    // This is the core regression: when a fallback attempt inherits a
    // lastAssistant from the primary provider's error turn in session history,
    // the error context must still reflect the current attempt's provider.
    const result = resolveActiveErrorContext({
      lastAssistant: { provider: "openai-codex", model: "gpt-5.4" },
      provider: "deepseek",
      model: "deepseek-chat",
    });
    expect(result).toEqual({ provider: "deepseek", model: "deepseek-chat" });
  });

  it("uses current provider/model when lastAssistant has matching provider", () => {
    const result = resolveActiveErrorContext({
      lastAssistant: { provider: "deepseek", model: "deepseek-chat" },
      provider: "deepseek",
      model: "deepseek-chat",
    });
    expect(result).toEqual({ provider: "deepseek", model: "deepseek-chat" });
  });

  it("uses current provider/model when lastAssistant has empty provider", () => {
    const result = resolveActiveErrorContext({
      lastAssistant: { provider: undefined, model: undefined },
      provider: "gemini",
      model: "gemini-3-pro",
    });
    expect(result).toEqual({ provider: "gemini", model: "gemini-3-pro" });
  });
});
