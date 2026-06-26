// LM Studio embedding provider tests cover model preload context length resolution.
import { describe, expect, it } from "vitest";
import { resolveEmbeddingModelContextLength } from "./embedding-provider.js";

describe("resolveEmbeddingModelContextLength", () => {
  it("resolves model-level contextTokens before contextWindow", async () => {
    const result = await resolveEmbeddingModelContextLength(
      { contextTokens: 4096, contextWindow: 32768 } as Record<string, unknown>,
      undefined,
    );

    expect(result).toBe(4096);
  });

  it("falls back to model-level contextWindow when model has no contextTokens", async () => {
    const result = await resolveEmbeddingModelContextLength(
      { contextWindow: 8192 } as Record<string, unknown>,
      undefined,
    );

    expect(result).toBe(8192);
  });

  it("falls back to provider-level contextTokens when model has no context config", async () => {
    const result = await resolveEmbeddingModelContextLength(undefined, {
      contextTokens: 2048,
      contextWindow: 65536,
    } as Record<string, unknown>);

    expect(result).toBe(2048);
  });

  it("falls back to provider-level contextWindow when neither model nor provider has contextTokens", async () => {
    const result = await resolveEmbeddingModelContextLength(undefined, {
      contextWindow: 4096,
    } as Record<string, unknown>);

    expect(result).toBe(4096);
  });

  it("returns undefined when no context config is set at any level", async () => {
    const result = await resolveEmbeddingModelContextLength(
      {} as Record<string, unknown>,
      {} as Record<string, unknown>,
    );

    expect(result).toBeUndefined();
  });
});
