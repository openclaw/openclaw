import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { buildSingleProviderApiKeyCatalog } from "openclaw/plugin-sdk/provider-catalog-shared";
import {
  TOKENHUB_MODEL_CATALOG,
  TOKENHUB_PROVIDER_ID,
  TOKEN_PLAN_MODEL_CATALOG,
  TOKEN_PLAN_PROVIDER_ID,
} from "./models.js";
import {
  applyTokenHubConfig,
  TOKENHUB_DEFAULT_MODEL_REF,
  applyTokenPlanConfig,
  TOKEN_PLAN_DEFAULT_MODEL_REF,
} from "./onboard.js";
import { buildTokenHubProvider, buildTokenPlanProvider } from "./provider-catalog.js";

function buildStaticCatalogEntries(providerId: string, catalog: typeof TOKENHUB_MODEL_CATALOG) {
  return catalog.map((entry) => ({
    provider: providerId,
    id: entry.id,
    name: entry.name,
    reasoning: entry.reasoning,
    input: [...entry.input],
    contextWindow: entry.contextWindow,
  }));
}

export default definePluginEntry({
  id: "tencent",
  name: "Tencent Cloud Provider",
  description: "Bundled Tencent Cloud provider plugins (TokenHub + Token Plan)",
  register(api) {
    // ---------- TokenHub provider ----------
    api.registerProvider({
      id: TOKENHUB_PROVIDER_ID,
      label: "Tencent TokenHub",
      docsPath: "/providers/tencent",
      envVars: ["TOKENHUB_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: TOKENHUB_PROVIDER_ID,
          methodId: "api-key",
          label: "Tencent TokenHub",
          hint: "Hy via Tencent TokenHub Gateway",
          optionKey: "tokenhubApiKey",
          flagName: "--tokenhub-api-key",
          envVar: "TOKENHUB_API_KEY",
          promptMessage: "Enter Tencent TokenHub API key",
          defaultModel: TOKENHUB_DEFAULT_MODEL_REF,
          expectedProviders: [TOKENHUB_PROVIDER_ID],
          applyConfig: (cfg) => applyTokenHubConfig(cfg),
          wizard: {
            choiceId: "tokenhub-api-key",
            choiceLabel: "Tencent TokenHub",
            groupId: "tencent",
            groupLabel: "Tencent Cloud",
            groupHint: "TokenHub + Token Plan",
          },
        }),
      ],
      catalog: {
        order: "simple",
        run: (ctx) =>
          buildSingleProviderApiKeyCatalog({
            ctx,
            providerId: TOKENHUB_PROVIDER_ID,
            buildProvider: buildTokenHubProvider,
          }),
      },
      augmentModelCatalog: () =>
        buildStaticCatalogEntries(TOKENHUB_PROVIDER_ID, TOKENHUB_MODEL_CATALOG),
    });

    // ---------- Token Plan provider ----------
    api.registerProvider({
      id: TOKEN_PLAN_PROVIDER_ID,
      label: "Tencent Token Plan",
      docsPath: "/providers/tencent",
      envVars: ["LKEAP_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: TOKEN_PLAN_PROVIDER_ID,
          methodId: "api-key",
          label: "Tencent Token Plan",
          hint: "Hy via Token Plan",
          optionKey: "tencentTokenPlanApiKey",
          flagName: "--tencent-token-plan-api-key",
          envVar: "LKEAP_API_KEY",
          promptMessage: "Enter Tencent Token Plan API key",
          defaultModel: TOKEN_PLAN_DEFAULT_MODEL_REF,
          expectedProviders: [TOKEN_PLAN_PROVIDER_ID],
          applyConfig: (cfg) => applyTokenPlanConfig(cfg),
          wizard: {
            choiceId: "tencent-token-plan-api-key",
            choiceLabel: "Tencent Token Plan",
            groupId: "tencent",
            groupLabel: "Tencent Cloud",
            groupHint: "TokenHub + Token Plan",
          },
        }),
      ],
      catalog: {
        order: "simple",
        run: (ctx) =>
          buildSingleProviderApiKeyCatalog({
            ctx,
            providerId: TOKEN_PLAN_PROVIDER_ID,
            buildProvider: buildTokenPlanProvider,
          }),
      },
      augmentModelCatalog: () =>
        buildStaticCatalogEntries(TOKEN_PLAN_PROVIDER_ID, TOKEN_PLAN_MODEL_CATALOG),
    });
  },
});
