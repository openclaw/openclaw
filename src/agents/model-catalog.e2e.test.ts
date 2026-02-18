import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { loadModelCatalog } from "./model-catalog.js";
import {
  installModelCatalogTestHooks,
  mockCatalogImportFailThenRecover,
} from "./model-catalog.test-harness.js";

describe("loadModelCatalog e2e smoke", () => {
  installModelCatalogTestHooks();

  it("recovers after an import failure on the next load", async () => {
    mockCatalogImportFailThenRecover();

    const cfg = {} as OpenClawConfig;
    expect(await loadModelCatalog({ config: cfg })).toEqual([]);
    expect(await loadModelCatalog({ config: cfg })).toEqual([
      { id: "gpt-4.1", name: "GPT-4.1", provider: "openai" },
    ]);
  });
});
