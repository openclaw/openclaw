// OmniRoute tests cover index plugin behavior.
import { readFileSync } from "node:fs";
import {
  registerProviderPlugin,
  registerSingleProviderPlugin,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  expectUnifiedModelCatalogProviderRegistration,
} from "openclaw/plugin-sdk/provider-test-contracts";
import { describe, expect, it } from "vitest";

import omniroutePlugin from "./index.js";
import { buildOmniRouteProvider } from "./provider-catalog.js";
import {
  applyOmniRouteConfig,
  applyOmniRouteProviderConfig,
} from "./onboard.js";
import {
  OMNIROUTE_API_KEY_ENV_VAR,
  OMNIROUTE_DEFAULT_BASE_URL,
  OMNIROUTE_DEFAULT_MODEL_ID,
  OMNIROUTE_DEFAULT_MODEL_REF,
  OMNIROUTE_LABEL,
  OMNIROUTE_PROVIDER_ID,
} from "./models.js";

type OmniRouteManifest = {
  providerAuthChoices?: Array<{
    provider?: string;
    method?: string;
    choiceId?: string;
    choiceLabel?: string;
    choiceHint?: string;
    groupId?: string;
    groupLabel?: string;
    groupHint?: string;
  }>;
};

function readManifest(): OmniRouteManifest {
  return JSON.parse(readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"));
}

describe("omniroute provider plugin", () => {
  it("registers the OmniRoute provider with correct id", async () => {
    const { providers } = await registerProviderPlugin({
      plugin: omniroutePlugin,
      id: OMNIROUTE_PROVIDER_ID,
      name: "OmniRoute Provider",
    });

    expect(providers.map((p) => p.id)).toEqual([OMNIROUTE_PROVIDER_ID]);
    expect(providers[0].id).toBe("omniroute");
  });

  it("registers a single provider plugin with API-key auth method", async () => {
    const provider = await registerSingleProviderPlugin(omniroutePlugin);

    expect(provider.id).toBe(OMNIROUTE_PROVIDER_ID);
    expect(provider.label).toBe(OMNIROUTE_LABEL);
    expect(provider.auth).toHaveLength(1);
    expect(provider.auth[0]).toMatchObject({
      id: "api-key",
      label: "OmniRoute API key",
    });
  });

  it("exposes auth choice metadata matching the manifest", async () => {
    const provider = await registerSingleProviderPlugin(omniroutePlugin);
    const manifestChoices = readManifest().providerAuthChoices?.map((choice) => ({
      provider: choice.provider,
      method: choice.method,
      choiceId: choice.choiceId,
      choiceLabel: choice.choiceLabel,
      choiceHint: choice.choiceHint,
      groupId: choice.groupId,
      groupLabel: choice.groupLabel,
      groupHint: choice.groupHint,
    }));

    const runtimeChoices = provider.auth.map((method) => ({
      provider: provider.id,
      method: method.id,
      choiceId: method.wizard?.choiceId,
      choiceLabel: method.wizard?.choiceLabel,
      choiceHint: method.wizard?.choiceHint,
      groupId: method.wizard?.groupId,
      groupLabel: method.wizard?.groupLabel,
      groupHint: method.wizard?.groupHint,
    }));

    expect(runtimeChoices).toEqual(manifestChoices);
  });

  it("builds a provider catalog with correct baseUrl, api, and models", () => {
    const catalog = buildOmniRouteProvider();

    expect(catalog.baseUrl).toBe(OMNIROUTE_DEFAULT_BASE_URL);
    expect(catalog.api).toBe("openai-completions");
    expect(catalog.models).toHaveLength(1);
    expect(catalog.models![0]).toMatchObject({
      id: OMNIROUTE_DEFAULT_MODEL_ID,
      name: "Auto (OmniRoute)",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 128_000,
      maxTokens: 16_384,
    });
  });

  it("exposes the default model ref constant", () => {
    expect(OMNIROUTE_DEFAULT_MODEL_REF).toBe("omniroute/auto");
  });

  it("applies OmniRoute provider config correctly", () => {
    const config = applyOmniRouteProviderConfig({} as never);

    expect(config).toBeDefined();
  });

  it("applies full OmniRoute config including default model", () => {
    const config = applyOmniRouteConfig({} as never);

    expect(config).toBeDefined();
  });

  it("registers through the unified model catalog provider path", async () => {
    const modelCatalogProvider = expectUnifiedModelCatalogProviderRegistration({
      plugin: omniroutePlugin,
      pluginId: OMNIROUTE_PROVIDER_ID,
      pluginName: "OmniRoute Provider",
      provider: OMNIROUTE_PROVIDER_ID,
      kind: "text",
    });

    expect(modelCatalogProvider.liveCatalog).toBeTypeOf("function");
  });

  it("exposes env vars for auth", async () => {
    const { providers } = await registerProviderPlugin({
      plugin: omniroutePlugin,
      id: OMNIROUTE_PROVIDER_ID,
      name: "OmniRoute Provider",
    });

    expect(providers[0].envVars).toContain(OMNIROUTE_API_KEY_ENV_VAR);
  });

  it("has a valid manifest with correct provider id", () => {
    const manifest = readManifest();

    expect(manifest).toMatchObject({
      id: "omniroute",
      providers: ["omniroute"],
      enabledByDefault: true,
    });
  });
});
