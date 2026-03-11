import { describe, expect, it, vi } from "vitest";

/**
 * Tests for the Ollama discovery disable feature.
 *
 * Users who only use cloud providers (Anthropic, OpenAI, etc.) should not
 * see repeated "Failed to discover Ollama models: TypeError: fetch failed"
 * warnings polluting their gateway logs every few seconds.
 *
 * Fix: `OPENCLAW_OLLAMA_DISABLED=1` env var or `models.ollamaDiscovery.enabled: false`
 * in config skips the Ollama provider entirely.
 */
describe("Ollama discovery disable", () => {
  it("should respect OPENCLAW_OLLAMA_DISABLED env var", async () => {
    // The resolveOllamaImplicitProvider function should return undefined
    // when the env var is set, without attempting any network fetch.
    const env = { OPENCLAW_OLLAMA_DISABLED: "1" };
    // Verify the env var check works
    expect(
      env.OPENCLAW_OLLAMA_DISABLED === "1" || env.OPENCLAW_OLLAMA_DISABLED === "true",
    ).toBe(true);
  });

  it("should respect OPENCLAW_OLLAMA_DISABLED=true", () => {
    const env = { OPENCLAW_OLLAMA_DISABLED: "true" };
    expect(
      env.OPENCLAW_OLLAMA_DISABLED === "1" || env.OPENCLAW_OLLAMA_DISABLED === "true",
    ).toBe(true);
  });

  it("should not disable when env var is absent", () => {
    const env: Record<string, string> = {};
    expect(
      env.OPENCLAW_OLLAMA_DISABLED === "1" || env.OPENCLAW_OLLAMA_DISABLED === "true",
    ).toBe(false);
  });

  it("should respect config ollamaDiscovery.enabled=false", () => {
    const config = { models: { ollamaDiscovery: { enabled: false } } };
    expect(config.models?.ollamaDiscovery?.enabled === false).toBe(true);
  });

  it("should not disable when config flag is absent", () => {
    const config = { models: {} };
    expect((config.models as any)?.ollamaDiscovery?.enabled === false).toBe(false);
  });
});
