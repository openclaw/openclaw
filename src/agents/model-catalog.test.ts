import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  __setModelCatalogImportForTest,
  loadModelCatalog,
  resetModelCatalogCacheForTest,
} from "./model-catalog.js";

type PiSdkModule = typeof import("./pi-model-discovery.js");

async function loadCanonicalFactsModule() {
  const module = await import("./model-facts.js").catch(() => null);
  if (!module?.getCanonicalForwardCompatModelFacts) {
    expect(module?.getCanonicalForwardCompatModelFacts).toBeTypeOf("function");
    return null;
  }
  return module;
}

vi.mock("./models-config.js", () => ({
  ensureOpenClawModelsJson: vi.fn().mockResolvedValue({ agentDir: "/tmp", wrote: false }),
}));

vi.mock("./agent-paths.js", () => ({
  resolveOpenClawAgentDir: () => "/tmp/openclaw",
}));

describe("loadModelCatalog", () => {
  beforeEach(() => {
    resetModelCatalogCacheForTest();
  });

  afterEach(() => {
    __setModelCatalogImportForTest();
    resetModelCatalogCacheForTest();
    vi.restoreAllMocks();
  });

  it("retries after import failure without poisoning the cache", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let call = 0;

    __setModelCatalogImportForTest(async () => {
      call += 1;
      if (call === 1) {
        throw new Error("boom");
      }
      return {
        AuthStorage: class {},
        ModelRegistry: class {
          getAll() {
            return [{ id: "gpt-4.1", name: "GPT-4.1", provider: "openai" }];
          }
        },
      } as unknown as PiSdkModule;
    });

    const cfg = {} as OpenClawConfig;
    const first = await loadModelCatalog({ config: cfg });
    expect(first).toEqual([]);

    const second = await loadModelCatalog({ config: cfg });
    expect(second).toEqual([{ id: "gpt-4.1", name: "GPT-4.1", provider: "openai" }]);
    expect(call).toBe(2);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("returns partial results on discovery errors", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

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

  it("matches the canonical codex facts layer for gpt-5.4", async () => {
    const factsModule = await loadCanonicalFactsModule();
    if (!factsModule) {
      return;
    }

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
                  input: ["text", "image"],
                  contextWindow: 200000,
                  maxTokens: 64000,
                },
              ];
            }
          },
        }) as unknown as PiSdkModule,
    );

    const canonical = factsModule.getCanonicalForwardCompatModelFacts("openai-codex", "gpt-5.4");
    expect(canonical).toMatchObject({
      provider: "openai-codex",
      id: "gpt-5.4",
      name: "gpt-5.4",
      contextWindow: 1_050_000,
      maxTokens: 128_000,
    });

    const result = await loadModelCatalog({ config: {} as OpenClawConfig });
    const gpt54 = result.find(
      (entry) => entry.provider === "openai-codex" && entry.id === "gpt-5.4",
    );
    expect(gpt54).toMatchObject({
      provider: canonical.provider,
      id: canonical.id,
      name: canonical.name,
      contextWindow: canonical.contextWindow,
      maxTokens: canonical.maxTokens,
    });
  });
});
