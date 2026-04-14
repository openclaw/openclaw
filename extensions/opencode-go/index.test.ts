import type { ModelCatalogEntry } from "openclaw/plugin-sdk/agent-runtime";
import { describe, expect, it } from "vitest";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import { expectPassthroughReplayPolicy } from "../../test/helpers/provider-replay-policy.ts";
import plugin from "./index.js";

function buildCatalogEntry(overrides: Partial<ModelCatalogEntry>): ModelCatalogEntry {
  return {
    provider: "opencode-go",
    id: "minimax-m2.5",
    name: "MiniMax M2.5",
    reasoning: true,
    input: ["text"],
    contextWindow: 256_000,
    ...overrides,
  };
}

describe("opencode-go provider plugin", () => {
  it("owns passthrough-gemini replay policy for Gemini-backed models", async () => {
    await expectPassthroughReplayPolicy({
      plugin,
      providerId: "opencode-go",
      modelId: "gemini-2.5-pro",
      sanitizeThoughtSignatures: true,
    });
  });

  it("keeps non-Gemini replay policy minimal on passthrough routes", async () => {
    await expectPassthroughReplayPolicy({
      plugin,
      providerId: "opencode-go",
      modelId: "qwen3-coder",
    });
  });

  it("adds a forward-compatible MiniMax M2.7 catalog row from the MiniMax M2.5 template", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const context = {
      env: process.env,
      entries: [buildCatalogEntry({})],
    } satisfies Parameters<NonNullable<typeof provider.augmentModelCatalog>>[0];
    const result = await provider.augmentModelCatalog?.(context);

    expect(result).toEqual([
      expect.objectContaining({
        provider: "opencode-go",
        id: "minimax-m2.7",
        name: "MiniMax M2.7",
        reasoning: true,
        input: ["text"],
        contextWindow: 256_000,
      }),
    ]);
  });

  it("does not duplicate MiniMax M2.7 when the catalog already contains it", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const context = {
      env: process.env,
      entries: [
        buildCatalogEntry({ id: "minimax-m2.5", name: "MiniMax M2.5" }),
        buildCatalogEntry({ id: "minimax-m2.7", name: "MiniMax M2.7" }),
      ],
    } satisfies Parameters<NonNullable<typeof provider.augmentModelCatalog>>[0];
    const result = await provider.augmentModelCatalog?.(context);

    expect(result ?? []).toEqual([]);
  });
});
