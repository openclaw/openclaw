import { describe, expect, it, vi } from "vitest";
import { resolveCopilotForwardCompatModel } from "./models.js";
import { createMockCtx, requireResolvedModel } from "./models.test-support.js";

vi.mock("openclaw/plugin-sdk/provider-model-shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-model-shared")>()),
  normalizeModelCompat: (model: Record<string, unknown>) => model,
}));

describe("resolveCopilotForwardCompatModel", () => {
  it("returns undefined for empty modelId", () => {
    expect(resolveCopilotForwardCompatModel(createMockCtx(""))).toBeUndefined();
    expect(resolveCopilotForwardCompatModel(createMockCtx("  "))).toBeUndefined();
  });

  it("returns undefined when model is already in registry", () => {
    const ctx = createMockCtx("gpt-4o", {
      "github-copilot/gpt-4o": { id: "gpt-4o", name: "gpt-4o" },
    });
    expect(resolveCopilotForwardCompatModel(ctx)).toBeUndefined();
  });

  it("uses static metadata for gpt-5.5 when live discovery rows are unavailable", () => {
    const result = requireResolvedModel(createMockCtx("gpt-5.5"));
    expect(result).toEqual({
      id: "gpt-5.5",
      name: "GPT-5.5",
      provider: "github-copilot",
      api: "openai-responses",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
      contextWindow: 1_050_000,
      contextTokens: 272_000,
      maxTokens: 128_000,
      thinkingLevelMap: { minimal: "low", xhigh: "xhigh", max: null },
      compat: {
        codeMode: "capable",
        supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
      },
    });
  });

  it("preserves static Anthropic thinking maps for legacy Claude Opus configured ids", () => {
    const opus46 = requireResolvedModel(createMockCtx("claude-opus-4.6-1m"));
    expect(opus46.thinkingLevelMap).toEqual({ xhigh: null, max: null });

    const result = requireResolvedModel(createMockCtx("claude-opus-4.7-1m-internal"));
    expect(result.thinkingLevelMap).toEqual({ xhigh: "xhigh", max: null });
    expect(result.compat).toEqual({
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
    });
  });

  it("creates synthetic model for arbitrary unknown model ID", () => {
    const ctx = createMockCtx("future-model");
    const result = requireResolvedModel(ctx);
    expect(result.id).toBe("future-model");
    expect(result.name).toBe("future-model");
    expect(result.contextWindow).toBe(128_000);
    expect(result.contextWindowSource).toBe("synthetic");
    expect((result as unknown as Record<string, unknown>).api).toBe("openai-responses");
    expect((result as unknown as Record<string, unknown>).input).toEqual(["text", "image"]);
  });

  it("disables eager tool streaming for synthetic Copilot Claude 4.5 models", () => {
    const result = requireResolvedModel(createMockCtx("claude-haiku-4.5"));
    expect(result.api).toBe("anthropic-messages");
    expect(result.compat).toEqual({ supportsEagerToolInputStreaming: false });
  });

  it("creates synthetic Gemini models with Chat Completions compatibility", () => {
    const result = requireResolvedModel(createMockCtx("gemini-3.1-pro-preview"));
    expect((result as unknown as Record<string, unknown>).api).toBe("openai-completions");
    // The manifest row now declares its conservative code-mode tier explicitly
    // (shared-upstream-model contract), and the static override passes the full
    // manifest compat through to the resolved model.
    expect((result as unknown as Record<string, unknown>).compat).toEqual({
      codeMode: "capable",
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsUsageInStreaming: false,
      maxTokensField: "max_tokens",
    });
  });

  it("infers reasoning=true for o1/o3 model IDs", () => {
    for (const id of ["o1", "o3", "o3-mini", "o1-preview"]) {
      const ctx = createMockCtx(id);
      const result = requireResolvedModel(ctx);
      expect((result as unknown as Record<string, unknown>).reasoning).toBe(true);
    }
  });

  it("infers reasoning=true for Codex model IDs", () => {
    for (const id of ["gpt-5.4-codex", "gpt-5.5-codex", "gpt-5.4-codex-mini", "gpt-5.3-codex"]) {
      const ctx = createMockCtx(id);
      const result = requireResolvedModel(ctx);
      expect((result as unknown as Record<string, unknown>).reasoning).toBe(true);
    }
  });

  it("sets reasoning=false for non-reasoning model IDs including mid-string o1/o3", () => {
    for (const id of ["gpt-4o", "mycodexmodel", "audio-o1-hd", "turbo-o3-voice"]) {
      const ctx = createMockCtx(id);
      const result = requireResolvedModel(ctx);
      expect((result as unknown as Record<string, unknown>).reasoning).toBe(false);
    }
  });
});
