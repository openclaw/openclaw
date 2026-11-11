import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(
  readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
) as {
  providerAuthAliases?: Record<string, string>;
  modelCatalog?: {
    aliases?: Record<string, { provider?: string }>;
  };
};

describe("xAI plugin manifest", () => {
  it("owns the shipped x-ai auth and catalog aliases", () => {
    expect(manifest.providerAuthAliases).toEqual({ "x-ai": "xai" });
    // Discovery also answers under x-ai; the catalog must publish those rows as xai.
    expect(manifest.modelCatalog?.aliases).toEqual({ "x-ai": { provider: "xai" } });
  });
});
