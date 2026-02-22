import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { __setModelCatalogImportForTest, loadModelCatalog } from "./model-catalog.js";
import {
  installModelCatalogTestHooks,
  mockCatalogImportFailThenRecover,
  type PiSdkModule,
} from "./model-catalog.test-harness.js";

describe("loadModelCatalog", () => {
  installModelCatalogTestHooks();

  it("retries after import failure without poisoning the cache", async () => {
    setLoggerOverride({ level: "silent", consoleLevel: "warn" });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const getCallCount = mockCatalogImportFailThenRecover();

      const cfg = {} as OpenClawConfig;
      const first = await loadModelCatalog({ config: cfg });
      expect(first).toEqual([]);

      const second = await loadModelCatalog({ config: cfg });
      expect(second).toEqual([{ id: "gpt-4.1", name: "GPT-4.1", provider: "openai" }]);
      expect(getCallCount()).toBe(2);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      setLoggerOverride(null);
      resetLogger();
    }
  });

  it("returns partial results on discovery errors", async () => {
    setLoggerOverride({ level: "silent", consoleLevel: "warn" });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      __setModelCatalogImportForTest(
        async () =>
          ({
            AuthStorage: class {},
            ModelRegistry: class {
              getAll() {
                return [
                  { id: "gpt-4.1", name: "GPT-4.1", provider: "openai" },
                  {
                    get id() {
                      throw new Error("boom");
                    },
                    provider: "openai",
                    name: "bad",
                  },
                ];
              }
            },
          }) as unknown as PiSdkModule,
      );

      const result = await loadModelCatalog({ config: {} as OpenClawConfig });
      expect(result).toEqual([{ id: "gpt-4.1", name: "GPT-4.1", provider: "openai" }]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      setLoggerOverride(null);
      resetLogger();
    }
  });

  it("adds openai-codex/gpt-5.3-codex-spark when base gpt-5.3-codex exists", async () => {
    __setModelCatalogImportForTest(
      async () =>
        ({
          AuthStorage: class {},
          ModelRegistry: class {
            getAll() {
              return [
                {
                  id: "gpt-5.3-codex",
                  provider: "openai-codex",
                  name: "GPT-5.3 Codex",
                  reasoning: true,
                  contextWindow: 200000,
                  input: ["text"],
                },
                {
                  id: "gpt-5.2-codex",
                  provider: "openai-codex",
                  name: "GPT-5.2 Codex",
                },
              ];
            }
          },
        }) as unknown as PiSdkModule,
    );

    const result = await loadModelCatalog({ config: {} as OpenClawConfig });
    expect(result).toContainEqual(
      expect.objectContaining({
        provider: "openai-codex",
        id: "gpt-5.3-codex-spark",
      }),
    );
    const spark = result.find((entry) => entry.id === "gpt-5.3-codex-spark");
    expect(spark?.name).toBe("gpt-5.3-codex-spark");
    expect(spark?.reasoning).toBe(true);
  });

  it("synthesizes google-antigravity/claude-opus-4-6 from claude-opus-4-5 template", async () => {
    __setModelCatalogImportForTest(
      async () =>
        ({
          AuthStorage: class {},
          ModelRegistry: class {
            getAll() {
              return [
                {
                  id: "claude-opus-4-5",
                  provider: "google-antigravity",
                  name: "Claude Opus 4.5",
                  reasoning: true,
                  contextWindow: 200000,
                  input: ["text", "image"],
                },
                {
                  id: "claude-opus-4-5-thinking",
                  provider: "google-antigravity",
                  name: "Claude Opus 4.5 Thinking",
                  reasoning: true,
                  contextWindow: 200000,
                  input: ["text", "image"],
                },
                {
                  id: "gemini-3-pro",
                  provider: "google-antigravity",
                  name: "Gemini 3 Pro",
                },
              ];
            }
          },
        }) as unknown as PiSdkModule,
    );

    const result = await loadModelCatalog({ config: {} as OpenClawConfig });

    // claude-opus-4-6 synthesized from claude-opus-4-5
    const opus46 = result.find(
      (e) => e.provider === "google-antigravity" && e.id === "claude-opus-4-6",
    );
    expect(opus46).toBeDefined();
    expect(opus46?.name).toBe("claude-opus-4-6");
    expect(opus46?.reasoning).toBe(true);
    expect(opus46?.contextWindow).toBe(200000);

    // claude-opus-4-6-thinking synthesized from claude-opus-4-5-thinking
    const opus46Thinking = result.find(
      (e) => e.provider === "google-antigravity" && e.id === "claude-opus-4-6-thinking",
    );
    expect(opus46Thinking).toBeDefined();
    expect(opus46Thinking?.name).toBe("claude-opus-4-6-thinking");
  });

  it("does not duplicate claude-opus-4-6 when already in catalog", async () => {
    __setModelCatalogImportForTest(
      async () =>
        ({
          AuthStorage: class {},
          ModelRegistry: class {
            getAll() {
              return [
                {
                  id: "claude-opus-4-5",
                  provider: "google-antigravity",
                  name: "Claude Opus 4.5",
                },
                {
                  id: "claude-opus-4-6",
                  provider: "google-antigravity",
                  name: "Claude Opus 4.6 (native)",
                },
              ];
            }
          },
        }) as unknown as PiSdkModule,
    );

    const result = await loadModelCatalog({ config: {} as OpenClawConfig });
    const opus46Entries = result.filter(
      (e) => e.provider === "google-antigravity" && e.id === "claude-opus-4-6",
    );
    expect(opus46Entries).toHaveLength(1);
    expect(opus46Entries[0]?.name).toBe("Claude Opus 4.6 (native)");
  });
});
