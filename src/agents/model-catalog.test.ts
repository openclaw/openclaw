import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  __setModelCatalogImportForTest,
  getLatestModels,
  isLatestModel,
  loadModelCatalog,
  type ModelCatalogEntry,
} from "./model-catalog.js";
import {
  installModelCatalogTestHooks,
  mockCatalogImportFailThenRecover,
  type PiSdkModule,
} from "./model-catalog.test-harness.js";

describe("loadModelCatalog", () => {
  installModelCatalogTestHooks();

  it("retries after import failure without poisoning the cache", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const getCallCount = mockCatalogImportFailThenRecover();

    const cfg = {} as OpenClawConfig;
    const first = await loadModelCatalog({ config: cfg });
    expect(first).toEqual([]);

    const second = await loadModelCatalog({ config: cfg });
expect(second).toEqual([{ id: "gpt-4.1", name: "GPT-4.1", provider: "openai" }]);
    expect(getCallCount()).toBe(2);
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
    expect(result.find((m) => m.id === "gpt-4.1")).toEqual({
      id: "gpt-4.1",
      name: "GPT-4.1",
      provider: "openai",
    });
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
});

describe("isLatestModel", () => {
  const entry = (id: string): ModelCatalogEntry => ({
    id,
    name: id,
    provider: "test",
  });

  it("should return true for canonical model IDs without date suffix", () => {
    expect(isLatestModel(entry("claude-opus-4-6"))).toBe(true);
    expect(isLatestModel(entry("gpt-5"))).toBe(true);
    expect(isLatestModel(entry("o4-mini"))).toBe(true);
    expect(isLatestModel(entry("gpt-4o-mini"))).toBe(true);
  });

  it("should return false for IDs ending with YYYYMMDD", () => {
    expect(isLatestModel(entry("claude-opus-4-5-20251101"))).toBe(false);
    // claude-3-5-haiku-20241022 is allowlisted as canonical (not a snapshot)
    expect(isLatestModel(entry("claude-3-5-haiku-20241022"))).toBe(true);
  });

  it("should return false for IDs ending with YYYY-MM-DD", () => {
    expect(isLatestModel(entry("gpt-4o-2024-11-20"))).toBe(false);
    expect(isLatestModel(entry("gpt-4o-2024-05-13"))).toBe(false);
  });
});

describe("getLatestModels", () => {
  const entry = (id: string): ModelCatalogEntry => ({
    id,
    name: id,
    provider: "test",
  });

  it("should filter out dated snapshots and keep canonical entries", () => {
    const catalog = [
      entry("claude-opus-4-6"),
      entry("claude-opus-4-5"),
      entry("claude-opus-4-5-20251101"),
      entry("gpt-4o"),
      entry("gpt-4o-2024-11-20"),
      entry("gpt-5"),
    ];

    const latest = getLatestModels(catalog);
    expect(latest.map((e) => e.id)).toEqual([
      "claude-opus-4-6",
      "claude-opus-4-5",
      "gpt-4o",
      "gpt-5",
    ]);
  });

  it("should return all entries when none have date suffixes", () => {
    const catalog = [entry("gpt-5"), entry("o4-mini"), entry("claude-opus-4-6")];
    expect(getLatestModels(catalog)).toHaveLength(3);
  });
});
