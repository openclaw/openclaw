import { CUSTOM_LOCAL_AUTH_MARKER } from "openclaw/plugin-sdk/provider-auth";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { expect, it } from "vitest";
import manifest from "./openclaw.plugin.json" with { type: "json" };

it("provides local auth through its manifest entry before runtime activation", async () => {
  const metadata: { id: string; providerCatalogEntry?: string } = manifest;
  if (!metadata.providerCatalogEntry) {
    throw new Error("LM Studio must expose a lightweight catalog entry");
  }
  const { default: provider }: { default: ProviderPlugin } = await import(
    metadata.providerCatalogEntry
  );
  expect(
    provider.resolveSyntheticAuth?.({
      provider: "lmstudio",
      config: {},
      providerConfig: { baseUrl: "http://localhost:1234/v1", models: [] },
    }),
  ).toMatchObject({ apiKey: CUSTOM_LOCAL_AUTH_MARKER, mode: "api-key" });
});
