import type { Api, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { normalizeModelCompat } from "./model-compat.js";

const baseModel = (): Model<Api> =>
  ({
    id: "glm-4.7",
    name: "GLM-4.7",
    api: "openai-completions",
    provider: "zai",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 1024,
  }) as Model<Api>;

describe("normalizeModelCompat", () => {
  it("forces supportsDeveloperRole off for z.ai models", () => {
    const model = baseModel();
    delete (model as { compat?: unknown }).compat;
    const normalized = normalizeModelCompat(model);
    expect(normalized.compat?.supportsDeveloperRole).toBe(false);
  });

  it("leaves non-zai models untouched", () => {
    const model = {
      ...baseModel(),
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
    };
    delete (model as { compat?: unknown }).compat;
    const normalized = normalizeModelCompat(model);
    expect(normalized.compat).toBeUndefined();
  });

  it("does not override explicit z.ai compat false", () => {
    const model = baseModel();
    model.compat = { supportsDeveloperRole: false };
    const normalized = normalizeModelCompat(model);
    expect(normalized.compat?.supportsDeveloperRole).toBe(false);
  });

  describe("provider prefix stripping", () => {
    it("strips anthropic/ prefix from model id", () => {
      const model = {
        ...baseModel(),
        id: "anthropic/claude-opus-4-5",
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
      };
      const normalized = normalizeModelCompat(model);
      expect(normalized.id).toBe("claude-opus-4-5");
    });

    it("strips provider prefix case-insensitively", () => {
      const model = {
        ...baseModel(),
        id: "Anthropic/claude-opus-4-5",
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
      };
      const normalized = normalizeModelCompat(model);
      expect(normalized.id).toBe("claude-opus-4-5");
    });

    it("does NOT strip openai/ prefix (not in allowlist)", () => {
      const model = {
        ...baseModel(),
        id: "openai/gpt-4o",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
      };
      const normalized = normalizeModelCompat(model);
      expect(normalized.id).toBe("openai/gpt-4o");
    });

    it("leaves model id unchanged when no provider prefix", () => {
      const model = {
        ...baseModel(),
        id: "claude-opus-4-5",
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
      };
      const normalized = normalizeModelCompat(model);
      expect(normalized.id).toBe("claude-opus-4-5");
    });

    it("does not strip mismatched provider prefix", () => {
      const model = {
        ...baseModel(),
        id: "openai/gpt-4o",
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
      };
      const normalized = normalizeModelCompat(model);
      expect(normalized.id).toBe("openai/gpt-4o");
    });

    it("handles empty provider gracefully", () => {
      const model = {
        ...baseModel(),
        id: "claude-opus-4-5",
        provider: "",
        baseUrl: "https://api.anthropic.com",
      };
      const normalized = normalizeModelCompat(model);
      expect(normalized.id).toBe("claude-opus-4-5");
    });
  });
});
