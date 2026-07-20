import { describe, expect, it } from "vitest";
import { resolveSubagentLightContext } from "./subagent-light-context.js";

const SMALL_CONTEXT_LIGHT_CONTEXT_TOKEN_LIMIT = 65_536;

describe("resolveSubagentLightContext", () => {
  it("honors explicit lightContext true", () => {
    expect(
      resolveSubagentLightContext({
        lightContext: true,
        resolvedModel: "openrouter/deepseek/deepseek-v4-flash",
        contextMode: "isolated",
      }),
    ).toBe(true);
  });

  it("honors explicit lightContext false even for ollama", () => {
    expect(
      resolveSubagentLightContext({
        lightContext: false,
        resolvedModel: "ollama/qwen2.5-coder:7b",
        contextMode: "isolated",
      }),
    ).toBe(false);
  });

  it("auto-enables for ollama models on isolated spawns", () => {
    expect(
      resolveSubagentLightContext({
        resolvedModel: "ollama/qwen2.5-coder:7b",
        contextMode: "isolated",
      }),
    ).toBe(true);
    expect(
      resolveSubagentLightContext({
        resolvedModel: "ollama/qwen3.5:9b",
        contextMode: "isolated",
      }),
    ).toBe(true);
  });

  it("keeps tiny-workspace bootstrap for the dedicated local-coder agent", () => {
    expect(
      resolveSubagentLightContext({
        targetAgentId: "local-coder",
        resolvedModel: "ollama/qwen2.5-coder:7b",
        contextMode: "isolated",
      }),
    ).toBe(false);
  });

  it("still allows explicit lightContext on local-coder", () => {
    expect(
      resolveSubagentLightContext({
        lightContext: true,
        targetAgentId: "local-coder",
        resolvedModel: "ollama/qwen2.5-coder:7b",
        contextMode: "isolated",
      }),
    ).toBe(true);
  });

  it("auto-enables when context window is at or below the small-context limit", () => {
    expect(
      resolveSubagentLightContext({
        resolvedModel: "openrouter/some/small-model",
        contextWindow: SMALL_CONTEXT_LIGHT_CONTEXT_TOKEN_LIMIT,
        contextMode: "isolated",
      }),
    ).toBe(true);
    expect(
      resolveSubagentLightContext({
        resolvedModel: "openrouter/some/large-model",
        contextWindow: SMALL_CONTEXT_LIGHT_CONTEXT_TOKEN_LIMIT + 1,
        contextMode: "isolated",
      }),
    ).toBe(false);
  });

  it("does not auto-enable for fork context unless explicitly requested", () => {
    expect(
      resolveSubagentLightContext({
        resolvedModel: "ollama/qwen2.5-coder:7b",
        contextMode: "fork",
      }),
    ).toBe(false);
  });

  it("does not auto-enable for cloud models without a small context window", () => {
    expect(
      resolveSubagentLightContext({
        resolvedModel: "openrouter/deepseek/deepseek-v4-flash",
        contextMode: "isolated",
      }),
    ).toBe(false);
  });
});
