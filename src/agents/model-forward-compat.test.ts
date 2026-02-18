import { describe, expect, it } from "vitest";
import { resolveForwardCompatModel } from "./model-forward-compat.js";
import type { ModelRegistry } from "./pi-model-discovery.js";

const SONNET_45_MODEL = {
  id: "claude-sonnet-4.5",
  name: "Claude Sonnet 4.5",
  api: "openai-responses" as const,
  provider: "github-copilot",
  reasoning: false,
  input: ["text", "image"] as ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8192,
};

function makeRegistry(
  entries: Array<{ provider: string; id: string; model: object }>,
): ModelRegistry {
  return {
    find: (provider: string, id: string) => {
      const match = entries.find((e) => e.provider === provider && e.id === id);
      return (match?.model ?? null) as ReturnType<ModelRegistry["find"]>;
    },
  } as unknown as ModelRegistry;
}

describe("resolveForwardCompatModel — github-copilot/claude-sonnet-4.6", () => {
  it("resolves github-copilot/claude-sonnet-4.6 using sonnet-4.5 as template", () => {
    const registry = makeRegistry([
      { provider: "github-copilot", id: "claude-sonnet-4.5", model: SONNET_45_MODEL },
    ]);

    const result = resolveForwardCompatModel("github-copilot", "claude-sonnet-4.6", registry);

    expect(result).not.toBeUndefined();
    expect(result?.id).toBe("claude-sonnet-4.6");
  });

  it("resolves github-copilot/claude-sonnet-4-6 (hyphen variant) using sonnet-4-5 as template", () => {
    const registry = makeRegistry([
      {
        provider: "github-copilot",
        id: "claude-sonnet-4-5",
        model: { ...SONNET_45_MODEL, id: "claude-sonnet-4-5" },
      },
    ]);

    const result = resolveForwardCompatModel("github-copilot", "claude-sonnet-4-6", registry);

    expect(result).not.toBeUndefined();
    expect(result?.id).toBe("claude-sonnet-4-6");
  });

  it("still resolves anthropic/claude-sonnet-4.6 (existing behaviour unchanged)", () => {
    const registry = makeRegistry([
      {
        provider: "anthropic",
        id: "claude-sonnet-4.5",
        model: { ...SONNET_45_MODEL, provider: "anthropic" },
      },
    ]);

    const result = resolveForwardCompatModel("anthropic", "claude-sonnet-4.6", registry);

    expect(result).not.toBeUndefined();
    expect(result?.id).toBe("claude-sonnet-4.6");
  });

  it("returns undefined for an unrelated provider", () => {
    const registry = makeRegistry([]);
    const result = resolveForwardCompatModel("openai", "claude-sonnet-4.6", registry);
    expect(result).toBeUndefined();
  });
});
