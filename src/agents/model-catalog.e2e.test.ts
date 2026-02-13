import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  __setModelCatalogImportForTest,
  loadModelCatalog,
  resetModelCatalogCacheForTest,
} from "./model-catalog.js";

type PiSdkModule = typeof import("./pi-model-discovery.js");

vi.mock("./models-config.js", () => ({
  ensureOpenClawModelsJson: vi.fn().mockResolvedValue({ agentDir: "/tmp", wrote: false }),
}));

vi.mock("./agent-paths.js", () => ({
  resolveOpenClawAgentDir: () => "/tmp/openclaw",
}));

describe("loadModelCatalog e2e smoke", () => {
  beforeEach(() => {
    resetModelCatalogCacheForTest();
  });

  afterEach(() => {
    __setModelCatalogImportForTest();
    resetModelCatalogCacheForTest();
    vi.restoreAllMocks();
  });

  it("recovers after an import failure on the next load", async () => {
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
    expect(await loadModelCatalog({ config: cfg })).toEqual([]);
    expect(await loadModelCatalog({ config: cfg })).toEqual([
      { id: "gpt-4.1", name: "GPT-4.1", provider: "openai" },
    ]);
  });
});
