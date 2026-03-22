import { describe, expect, it, vi } from "vitest";

vi.mock("@mariozechner/pi-ai/oauth", () => ({
  getOAuthApiKey: vi.fn(),
  getOAuthProviders: vi.fn(() => []),
}));

vi.mock("openclaw/plugin-sdk/provider-models", () => ({
  normalizeModelCompat: (model: Record<string, unknown>) => model,
}));

import type { ProviderResolveDynamicModelContext } from "openclaw/plugin-sdk/core";
import { resolveCopilotForwardCompatModel } from "./models.js";

function createMockCtx(
  modelId: string,
  registryModels: Record<string, Record<string, unknown>> = {},
): ProviderResolveDynamicModelContext {
  return {
    modelId,
    provider: "github-copilot",
    config: {},
    modelRegistry: {
      find: (provider: string, id: string) => registryModels[`${provider}/${id}`] ?? null,
    },
  } as unknown as ProviderResolveDynamicModelContext;
}

function requireResolvedModel(ctx: ProviderResolveDynamicModelContext) {
  const result = resolveCopilotForwardCompatModel(ctx);
  if (!result) {
    throw new Error(`expected model ${ctx.modelId} to resolve`);
  }
  return result;
}

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

  it("clones gpt-5.2-codex template for gpt-5.3-codex", () => {
    const template = {
      id: "gpt-5.2-codex",
      name: "gpt-5.2-codex",
      provider: "github-copilot",
      api: "openai-responses",
      reasoning: true,
      contextWindow: 200_000,
    };
    const ctx = createMockCtx("gpt-5.3-codex", {
      "github-copilot/gpt-5.2-codex": template,
    });
    const result = requireResolvedModel(ctx);
    expect(result.id).toBe("gpt-5.3-codex");
    expect(result.name).toBe("gpt-5.3-codex");
    expect((result as unknown as Record<string, unknown>).reasoning).toBe(true);
  });

  it("falls through to synthetic catch-all when codex template is missing", () => {
    const ctx = createMockCtx("gpt-5.3-codex");
    const result = requireResolvedModel(ctx);
    expect(result.id).toBe("gpt-5.3-codex");
  });

  it("creates synthetic model for arbitrary unknown model ID", () => {
    const ctx = createMockCtx("gpt-5.4-mini");
    const result = requireResolvedModel(ctx);
    expect(result.id).toBe("gpt-5.4-mini");
    expect(result.name).toBe("gpt-5.4-mini");
    expect((result as unknown as Record<string, unknown>).api).toBe("openai-responses");
    expect((result as unknown as Record<string, unknown>).input).toEqual(["text", "image"]);
  });

  it("infers reasoning=true for o1/o3 model IDs", () => {
    for (const id of ["o1", "o3", "o3-mini", "o1-preview"]) {
      const ctx = createMockCtx(id);
      const result = requireResolvedModel(ctx);
      expect((result as unknown as Record<string, unknown>).reasoning).toBe(true);
    }
  });

  it("sets reasoning=false for non-reasoning model IDs including mid-string o1/o3", () => {
    for (const id of [
      "gpt-5.4-mini",
      "claude-sonnet-4.6",
      "gpt-4o",
      "audio-o1-hd",
      "turbo-o3-voice",
    ]) {
      const ctx = createMockCtx(id);
      const result = requireResolvedModel(ctx);
      expect((result as unknown as Record<string, unknown>).reasoning).toBe(false);
    }
  });
});
