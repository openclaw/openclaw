import { CHUTES_OAUTH_MARKER } from "openclaw/plugin-sdk/agent-runtime";
import { definePluginEntry, type ProviderCatalogContext } from "openclaw/plugin-sdk/core";
import {
  createProviderApiKeyAuthMethod,
  ensureAuthProfileStore,
  listProfilesForProvider,
} from "openclaw/plugin-sdk/provider-auth";
import { CHUTES_DEFAULT_MODEL_REF, applyChutesApiKeyConfig } from "./onboard.js";
import { buildChutesProvider } from "./provider-catalog.js";

const PROVIDER_ID = "chutes";

/**
 * Resolve the Chutes implicit provider.
 * - If an API key is available (env var or api_key profile), use it directly.
 * - If an OAuth profile exists and no API key is present, use CHUTES_OAUTH_MARKER
 *   so the gateway injects the stored access token at request time.
 */
async function resolveCatalog(ctx: ProviderCatalogContext) {
  const { apiKey, discoveryApiKey } = ctx.resolveProviderApiKey(PROVIDER_ID);
  if (apiKey) {
    return {
      provider: {
        ...(await buildChutesProvider(discoveryApiKey)),
        apiKey,
      },
    };
  }

  const authStore = ensureAuthProfileStore(ctx.agentDir, {
    allowKeychainPrompt: false,
  });
  const oauthProfileId = listProfilesForProvider(authStore, PROVIDER_ID).find(
    (id) => authStore.profiles[id]?.type === "oauth",
  );
  if (!oauthProfileId) {
    return null;
  }

  // Pass the stored access token for authenticated model discovery.
  // discoverChutesModels retries without auth on 401, so an expired token degrades gracefully.
  const oauthCred = authStore.profiles[oauthProfileId];
  const accessToken = oauthCred?.type === "oauth" ? oauthCred.access : undefined;

  return {
    provider: {
      ...(await buildChutesProvider(accessToken)),
      apiKey: CHUTES_OAUTH_MARKER,
    },
  };
}

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "Chutes Provider",
  description: "Bundled Chutes.ai provider plugin",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Chutes",
      docsPath: "/providers/chutes",
      envVars: ["CHUTES_API_KEY", "CHUTES_OAUTH_TOKEN"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "Chutes API key",
          hint: "Open-source models including Llama, DeepSeek, and more",
          optionKey: "chutesApiKey",
          flagName: "--chutes-api-key",
          envVar: "CHUTES_API_KEY",
          promptMessage: "Enter Chutes API key",
          noteTitle: "Chutes",
          noteMessage: [
            "Chutes provides access to leading open-source models including Llama, DeepSeek, and more.",
            "Get your API key at: https://chutes.ai/settings/api-keys",
          ].join("\n"),
          defaultModel: CHUTES_DEFAULT_MODEL_REF,
          expectedProviders: ["chutes"],
          applyConfig: (cfg) => applyChutesApiKeyConfig(cfg),
          wizard: {
            choiceId: "chutes-api-key",
            choiceLabel: "Chutes API key",
            groupId: "chutes",
            groupLabel: "Chutes",
            groupHint: "OAuth + API key",
          },
        }),
      ],
      catalog: {
        order: "profile",
        run: resolveCatalog,
      },
    });
  },
});
