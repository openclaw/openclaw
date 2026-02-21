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
            discoverAuthStorage: () => ({}),
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
          discoverAuthStorage: () => ({}),
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

  it("merges configured models for opted-in non-pi-native providers", async () => {
    __setModelCatalogImportForTest(
      async () =>
        ({
          AuthStorage: class {},
          ModelRegistry: class {
            getAll() {
              return [{ id: "gpt-4.1", provider: "openai", name: "GPT-4.1" }];
            }
          },
        }) as unknown as PiSdkModule,
    );

    const result = await loadModelCatalog({
      config: {
        models: {
          providers: {
            kilocode: {
              baseUrl: "https://api.kilo.ai/api/gateway/",
              api: "openai-completions",
              models: [
                {
                  id: "google/gemini-3-pro-preview",
                  name: "Gemini 3 Pro Preview",
                  input: ["text", "image"],
                  reasoning: true,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 1048576,
                  maxTokens: 65536,
                },
              ],
            },
          },
        },
      } as OpenClawConfig,
    });

    expect(result).toContainEqual(
      expect.objectContaining({
        provider: "kilocode",
        id: "google/gemini-3-pro-preview",
        name: "Gemini 3 Pro Preview",
      }),
    );
  });

  it("does not merge configured models for providers that are not opted in", async () => {
    __setModelCatalogImportForTest(
      async () =>
        ({
          AuthStorage: class {},
          ModelRegistry: class {
            getAll() {
              return [{ id: "gpt-4.1", provider: "openai", name: "GPT-4.1" }];
            }
          },
        }) as unknown as PiSdkModule,
    );

    const result = await loadModelCatalog({
      config: {
        models: {
          providers: {
            qianfan: {
              baseUrl: "https://qianfan.baidubce.com/v2",
              api: "openai-completions",
              models: [
                {
                  id: "deepseek-v3.2",
                  name: "DEEPSEEK V3.2",
                  reasoning: true,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 98304,
                  maxTokens: 32768,
                },
              ],
            },
          },
        },
      } as OpenClawConfig,
    });

    expect(
      result.some((entry) => entry.provider === "qianfan" && entry.id === "deepseek-v3.2"),
    ).toBe(false);
  });

  it("does not duplicate opted-in configured models already present in ModelRegistry", async () => {
    __setModelCatalogImportForTest(
      async () =>
        ({
          AuthStorage: class {},
          ModelRegistry: class {
            getAll() {
              return [
                {
                  id: "anthropic/claude-opus-4.6",
                  provider: "kilocode",
                  name: "Claude Opus 4.6",
                },
              ];
            }
          },
        }) as unknown as PiSdkModule,
    );

    const result = await loadModelCatalog({
      config: {
        models: {
          providers: {
            kilocode: {
              baseUrl: "https://api.kilo.ai/api/gateway/",
              api: "openai-completions",
              models: [
                {
                  id: "anthropic/claude-opus-4.6",
                  name: "Configured Claude Opus 4.6",
                  reasoning: true,
                  input: ["text", "image"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 1000000,
                  maxTokens: 128000,
                },
              ],
            },
          },
        },
      } as OpenClawConfig,
    });

    const matches = result.filter(
      (entry) => entry.provider === "kilocode" && entry.id === "anthropic/claude-opus-4.6",
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.name).toBe("Claude Opus 4.6");
  });
});
