import { describe, expect, it } from "vitest";
import { resolveForwardCompatModel } from "./model-forward-compat.js";

/**
 * Minimal mock for ModelRegistry — only implements `find()` which is
 * the single method used by the forward-compat resolver.
 */
function createMockRegistry(models: Record<string, Record<string, unknown>>) {
  return {
    find(provider: string, modelId: string) {
      const key = `${provider}/${modelId}`;
      return models[key] ?? null;
    },
    // Satisfy the ModelRegistry shape with stubs
    list: () => [],
    has: () => false,
    register: () => {},
    resolve: () => null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const OPUS_45_TEMPLATE = {
  id: "claude-opus-4-5",
  name: "Claude Opus 4.5",
  api: "anthropic-messages",
  provider: "anthropic",
  reasoning: true,
  input: ["text", "image"],
  contextWindow: 200_000,
  maxTokens: 8_192,
  cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
};

const SONNET_45_TEMPLATE = {
  id: "claude-sonnet-4-5",
  name: "Claude Sonnet 4.5",
  api: "anthropic-messages",
  provider: "anthropic",
  reasoning: true,
  input: ["text", "image"],
  contextWindow: 200_000,
  maxTokens: 8_192,
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
};

describe("resolveForwardCompatModel — context window (#19633)", () => {
  it("patches Opus 4.6 contextWindow to 1M instead of inheriting 200k from 4.5 template", () => {
    const registry = createMockRegistry({
      "anthropic/claude-opus-4-5": OPUS_45_TEMPLATE,
    });

    const model = resolveForwardCompatModel("anthropic", "claude-opus-4-6", registry);

    expect(model).toBeDefined();
    expect(model!.id).toBe("claude-opus-4-6");
    expect(model!.contextWindow).toBe(1_000_000);
  });

  it("patches Sonnet 4.6 contextWindow to 1M instead of inheriting 200k from 4.5 template", () => {
    const registry = createMockRegistry({
      "anthropic/claude-sonnet-4-5": SONNET_45_TEMPLATE,
    });

    const model = resolveForwardCompatModel("anthropic", "claude-sonnet-4-6", registry);

    expect(model).toBeDefined();
    expect(model!.id).toBe("claude-sonnet-4-6");
    expect(model!.contextWindow).toBe(1_000_000);
  });

  it("patches dot-notation claude-opus-4.6 to 1M", () => {
    const registry = createMockRegistry({
      "anthropic/claude-opus-4.5": { ...OPUS_45_TEMPLATE, id: "claude-opus-4.5" },
    });

    const model = resolveForwardCompatModel("anthropic", "claude-opus-4.6", registry);

    expect(model).toBeDefined();
    expect(model!.contextWindow).toBe(1_000_000);
  });

  it("returns undefined when the template model is not in the registry", () => {
    const registry = createMockRegistry({});
    const model = resolveForwardCompatModel("anthropic", "claude-opus-4-6", registry);
    expect(model).toBeUndefined();
  });

  it("does not affect non-anthropic providers", () => {
    const registry = createMockRegistry({
      "anthropic/claude-opus-4-5": OPUS_45_TEMPLATE,
    });
    const model = resolveForwardCompatModel("openai", "claude-opus-4-6", registry);
    expect(model).toBeUndefined();
  });
});
