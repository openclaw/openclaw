import { emptyPluginConfigSchema, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { ensureAuthProfileStore, listProfilesForProvider } from "../../src/agents/auth-profiles.js";
import {
  buildCloudflareAiGatewayModelDefinition,
  resolveCloudflareAiGatewayBaseUrl,
} from "../../src/agents/cloudflare-ai-gateway.js";
import { resolveNonEnvSecretRefApiKeyMarker } from "../../src/agents/model-auth-markers.js";
import { coerceSecretRef } from "../../src/config/types.secrets.js";

const PROVIDER_ID = "cloudflare-ai-gateway";
const PROVIDER_ENV_VAR = "CLOUDFLARE_AI_GATEWAY_API_KEY";

function resolveApiKeyFromCredential(
  cred: ReturnType<typeof ensureAuthProfileStore>["profiles"][string] | undefined,
): string | undefined {
  if (!cred || cred.type !== "api_key") {
    return undefined;
  }

  const keyRef = coerceSecretRef(cred.keyRef);
  if (keyRef && keyRef.id.trim()) {
    return keyRef.source === "env"
      ? keyRef.id.trim()
      : resolveNonEnvSecretRefApiKeyMarker(keyRef.source);
  }
  return cred.key?.trim() || undefined;
}

const cloudflareAiGatewayPlugin = {
  id: PROVIDER_ID,
  name: "Cloudflare AI Gateway Provider",
  description: "Bundled Cloudflare AI Gateway provider plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Cloudflare AI Gateway",
      docsPath: "/providers/cloudflare-ai-gateway",
      envVars: ["CLOUDFLARE_AI_GATEWAY_API_KEY"],
      auth: [],
      catalog: {
        order: "late",
        run: async (ctx) => {
          const authStore = ensureAuthProfileStore(ctx.agentDir, {
            allowKeychainPrompt: false,
          });
          const envManagedApiKey = ctx.env[PROVIDER_ENV_VAR]?.trim() ? PROVIDER_ENV_VAR : undefined;
          for (const profileId of listProfilesForProvider(authStore, PROVIDER_ID)) {
            const cred = authStore.profiles[profileId];
            if (!cred || cred.type !== "api_key") {
              continue;
            }
            const apiKey = envManagedApiKey ?? resolveApiKeyFromCredential(cred);
            if (!apiKey) {
              continue;
            }
            const accountId = cred.metadata?.accountId?.trim();
            const gatewayId = cred.metadata?.gatewayId?.trim();
            if (!accountId || !gatewayId) {
              continue;
            }
            const baseUrl = resolveCloudflareAiGatewayBaseUrl({ accountId, gatewayId });
            if (!baseUrl) {
              continue;
            }
            return {
              provider: {
                baseUrl,
                api: "anthropic-messages",
                apiKey,
                models: [buildCloudflareAiGatewayModelDefinition()],
              },
            };
          }
          return null;
        },
      },
    });
  },
};

export default cloudflareAiGatewayPlugin;
