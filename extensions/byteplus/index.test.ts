// Byteplus tests cover index plugin behavior.
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";
import { BYTEPLUS_PROVIDER_CATALOG } from "./models.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

describe("byteplus plugin", () => {
  it("preserves both provider-owned static catalogs and paired ordering", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(provider.catalog?.order).toBe("paired");
    expect(provider.staticCatalog?.order).toBe("paired");
    expect(await provider.staticCatalog?.run({} as never)).toEqual({
      providers: Object.fromEntries(
        BYTEPLUS_PROVIDER_CATALOG.entries.map(({ id, buildProvider }) => [id, buildProvider()]),
      ),
    });
  });

  it("declares provider auth and streaming usage capabilities in the manifest", () => {
    expect(manifest.providerAuthAliases).toEqual({
      "byteplus-plan": "byteplus",
    });
    expect(manifest.providerRequest?.providers).toMatchObject({
      byteplus: { openAICompletions: { supportsStreamingUsage: true } },
      "byteplus-plan": { openAICompletions: { supportsStreamingUsage: true } },
    });
  });
});
