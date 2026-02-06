import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  __setModelCatalogImportForTest,
  getLatestModels,
  isLatestModel,
  loadModelCatalog,
  resetModelCatalogCacheForTest,
  type ModelCatalogEntry,
} from "./model-catalog.js";

type PiSdkModule = typeof import("./pi-model-discovery.js");

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
    expect(second.find((m) => m.id === "gpt-4.1")).toEqual({
      id: "gpt-4.1",
      name: "GPT-4.1",
      provider: "openai",
    });
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
    expect(result.find((m) => m.id === "gpt-4.1")).toEqual({
      id: "gpt-4.1",
      name: "GPT-4.1",
      provider: "openai",
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
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
    expect(isLatestModel(entry("claude-3-5-haiku-20241022"))).toBe(false);
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
