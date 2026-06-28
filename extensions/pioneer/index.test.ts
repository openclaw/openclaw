// Pioneer tests cover index plugin behavior and discovery wiring.
import { readFileSync } from "node:fs";
import {
  registerSingleProviderPlugin,
  resolveProviderPluginChoice,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import pioneerPlugin from "./index.js";
import pioneerProviderDiscovery from "./provider-discovery.js";

type PioneerManifest = {
  providerCatalogEntry?: string;
  modelCatalog?: {
    discovery?: Record<string, string>;
  };
};

function readManifest(): PioneerManifest {
  return JSON.parse(readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"));
}

describe("pioneer provider plugin", () => {
  it("registers Pioneer with api-key auth wizard metadata", async () => {
    const provider = await registerSingleProviderPlugin(pioneerPlugin);
    const resolved = resolveProviderPluginChoice({
      providers: [provider],
      choice: "pioneer-api-key",
    });

    expect(provider.id).toBe("pioneer");
    expect(provider.label).toBe("Pioneer");
    expect(provider.envVars).toEqual(["PIONEER_API_KEY"]);
    expect(provider.auth).toHaveLength(1);
    expect(resolved?.provider.id).toBe("pioneer");
    expect(resolved?.method.id).toBe("api-key");
  });

  it("declares runtime model discovery in the manifest", () => {
    const manifest = readManifest();

    expect(manifest.providerCatalogEntry).toBe("./provider-discovery.ts");
    expect(manifest.modelCatalog?.discovery?.pioneer).toBe("runtime");
  });

  it("exposes live catalog from the lightweight provider-discovery entry", () => {
    expect(pioneerProviderDiscovery.catalog?.run).toBeTypeOf("function");
    expect(pioneerProviderDiscovery.staticCatalog?.run).toBeTypeOf("function");
  });
});
