import type { Api, Model } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
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

const anthropicModel = (): Model<Api> =>
  ({
    id: "claude-opus-4-5",
    name: "Claude Opus 4.5",
    api: "anthropic-messages",
    provider: "anthropic",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
    contextWindow: 200000,
    maxTokens: 32000,
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
});

describe("normalizeModelCompat ANTHROPIC_BASE_URL", () => {
  const originalEnv = process.env.ANTHROPIC_BASE_URL;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.ANTHROPIC_BASE_URL;
    } else {
      process.env.ANTHROPIC_BASE_URL = originalEnv;
    }
  });

  it("uses custom baseUrl from ANTHROPIC_BASE_URL env var", () => {
    process.env.ANTHROPIC_BASE_URL = "http://localhost:3000/api";
    const model = anthropicModel();
    const normalized = normalizeModelCompat(model);
    expect(normalized.baseUrl).toBe("http://localhost:3000/api");
  });

  it("keeps default baseUrl when ANTHROPIC_BASE_URL is not set", () => {
    delete process.env.ANTHROPIC_BASE_URL;
    const model = { ...anthropicModel(), baseUrl: "https://api.anthropic.com" };
    const normalized = normalizeModelCompat(model);
    expect(normalized.baseUrl).toBe("https://api.anthropic.com");
  });

  it("overrides default Anthropic baseUrl when ANTHROPIC_BASE_URL is set", () => {
    process.env.ANTHROPIC_BASE_URL = "http://localhost:3000/api";
    const model = { ...anthropicModel(), baseUrl: "https://api.anthropic.com" };
    const normalized = normalizeModelCompat(model);
    expect(normalized.baseUrl).toBe("http://localhost:3000/api");
  });

  it("does not override explicit model baseUrl", () => {
    process.env.ANTHROPIC_BASE_URL = "http://localhost:3000/api";
    const model = { ...anthropicModel(), baseUrl: "https://custom.example.com" };
    const normalized = normalizeModelCompat(model);
    expect(normalized.baseUrl).toBe("https://custom.example.com");
  });

  it("ignores ANTHROPIC_BASE_URL for non-anthropic providers", () => {
    process.env.ANTHROPIC_BASE_URL = "http://localhost:3000/api";
    const model = { ...anthropicModel(), provider: "openai" };
    delete (model as { baseUrl?: unknown }).baseUrl;
    const normalized = normalizeModelCompat(model);
    expect(normalized.baseUrl).toBeUndefined();
  });

  it("trims whitespace from ANTHROPIC_BASE_URL", () => {
    process.env.ANTHROPIC_BASE_URL = "  http://localhost:3000/api  ";
    const model = anthropicModel();
    const normalized = normalizeModelCompat(model);
    expect(normalized.baseUrl).toBe("http://localhost:3000/api");
  });
});
