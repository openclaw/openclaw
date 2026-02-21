import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveImplicitProviders } from "./models-config.providers.js";

/**
 * Tests for Ollama auto-discovery (#4544).
 *
 * The e2e test file tests behavior in VITEST=true (discovery skipped).
 * These tests temporarily unset VITEST and mock fetch to exercise
 * the auto-discovery code path.
 */
describe("Ollama auto-discovery", () => {
  let originalVitest: string | undefined;
  let originalNodeEnv: string | undefined;
  let originalFetch: typeof globalThis.fetch;

  afterEach(() => {
    process.env.VITEST = originalVitest;
    if (originalNodeEnv !== undefined) {
      process.env.NODE_ENV = originalNodeEnv;
    } else {
      delete process.env.NODE_ENV;
    }
    globalThis.fetch = originalFetch;
    delete process.env.OLLAMA_API_KEY;
  });

  function setupDiscoveryEnv() {
    originalVitest = process.env.VITEST;
    originalNodeEnv = process.env.NODE_ENV;
    // Must clear both guards in discoverOllamaModels()
    delete process.env.VITEST;
    delete process.env.NODE_ENV;
    originalFetch = globalThis.fetch;
  }

  it("auto-registers ollama provider when models are discovered locally", async () => {
    setupDiscoveryEnv();
    globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
      if (String(url).includes("/api/tags")) {
        return {
          ok: true,
          json: async () => ({
            models: [{ name: "deepseek-r1:latest" }, { name: "llama3.3:latest" }],
          }),
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const providers = await resolveImplicitProviders({ agentDir });

    expect(providers?.ollama).toBeDefined();
    expect(providers?.ollama?.apiKey).toBe("ollama-local");
    expect(providers?.ollama?.api).toBe("ollama");
    expect(providers?.ollama?.baseUrl).toBe("http://127.0.0.1:11434");
    expect(providers?.ollama?.models).toHaveLength(2);
    expect(providers?.ollama?.models?.[0]?.id).toBe("deepseek-r1:latest");
    // deepseek-r1 should be tagged as reasoning
    expect(providers?.ollama?.models?.[0]?.reasoning).toBe(true);
    expect(providers?.ollama?.models?.[1]?.reasoning).toBe(false);
  });

  it("does not warn when Ollama is unreachable and no API key is configured", async () => {
    setupDiscoveryEnv();
    const warnSpy = vi.spyOn(console, "warn");
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:11434")) as typeof fetch;

    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const providers = await resolveImplicitProviders({ agentDir });

    expect(providers?.ollama).toBeUndefined();
    // Auto-discovery should be silent when not explicitly configured
    const ollamaWarnings = warnSpy.mock.calls.filter(
      (args) => typeof args[0] === "string" && args[0].includes("Ollama"),
    );
    expect(ollamaWarnings).toHaveLength(0);
    warnSpy.mockRestore();
  });

  it("warns when Ollama is unreachable but API key IS configured", async () => {
    setupDiscoveryEnv();
    process.env.OLLAMA_API_KEY = "test-key";
    const warnSpy = vi.spyOn(console, "warn");
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:11434")) as typeof fetch;

    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const providers = await resolveImplicitProviders({ agentDir });

    // Provider should still be registered (explicit key)
    expect(providers?.ollama).toBeDefined();
    expect(providers?.ollama?.apiKey).toBe("OLLAMA_API_KEY");
    // Should warn because user explicitly configured Ollama
    const ollamaWarnings = warnSpy.mock.calls.filter(
      (args) => typeof args[0] === "string" && args[0].includes("Ollama"),
    );
    expect(ollamaWarnings.length).toBeGreaterThan(0);
    warnSpy.mockRestore();
  });
});
