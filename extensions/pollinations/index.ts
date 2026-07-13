import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { createPollinationsOAuthAuthMethod } from "./oauth.js";
import { applyPollinationsConfig, POLLINATIONS_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildPollinationsProvider, POLLINATIONS_BASE_URL } from "./provider-catalog.js";

const PROVIDER_ID = "pollinations";

export default definePluginEntry({
  id: "pollinations",
  name: "Pollinations Provider",
  description: "Bundled Pollinations provider plugin",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Pollinations",
      docsPath: "/providers/models",
      envVars: ["POLLINATIONS_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "Pollinations API key",
          hint: "API key",
          optionKey: "pollinationsApiKey",
          flagName: "--pollinations-api-key",
          envVar: "POLLINATIONS_API_KEY",
          promptMessage: "Enter Pollinations API key",
          defaultModel: POLLINATIONS_DEFAULT_MODEL_REF,
          expectedProviders: [PROVIDER_ID],
          applyConfig: (cfg) => applyPollinationsConfig(cfg),
          wizard: {
            choiceId: "pollinations-api-key",
            choiceLabel: "Pollinations API key",
            groupId: PROVIDER_ID,
            groupLabel: "Pollinations",
            groupHint: "Login or API key",
          },
        }),
        createPollinationsOAuthAuthMethod(),
      ],
      catalog: {
        order: "simple",
        run: async (ctx) => {
          const apiKey = ctx.resolveProviderApiKey(PROVIDER_ID).apiKey;
          if (!apiKey) {
            return null;
          }
          return {
            provider: {
              ...buildPollinationsProvider(),
              apiKey,
            },
          };
        },
      },
      staticCatalog: {
        order: "simple",
        run: async () => ({
          provider: buildPollinationsProvider(),
        }),
      },
      normalizeConfig: ({ providerConfig }) => {
        const normalized = normalizePollinationsBaseUrl(providerConfig.baseUrl);
        return normalized && normalized !== providerConfig.baseUrl
          ? { ...providerConfig, baseUrl: normalized }
          : undefined;
      },
      normalizeModelId: ({ modelId }) => {
        if (typeof modelId !== "string") return undefined;
        const prefix = `${PROVIDER_ID}/`;
        return modelId.startsWith(prefix)
          ? modelId.slice(prefix.length)
          : modelId;
      },
      isModernModelRef: () => true,
      fetchUsageSnapshot: async (ctx) =>
        await fetchPollinationsUsage({
          token: ctx.token,
          timeoutMs: ctx.timeoutMs,
          fetchFn: ctx.fetchFn,
        }),
    });
  },
});

function normalizePollinationsBaseUrl(baseUrl: string | undefined): string | undefined {
  const normalized = (baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!normalized) return undefined;
  const validUrls = new Set([
    POLLINATIONS_BASE_URL,
    "https://gen.pollinations.ai",
    "https://gen.pollinations.ai/v1",
  ]);
  return validUrls.has(normalized) ? POLLINATIONS_BASE_URL : undefined;
}

async function fetchPollinationsUsage(ctx: {
  token: string;
  timeoutMs: number;
  fetchFn: typeof fetch;
}): Promise<{ balance?: number } | null> {
  try {
    const response = await ctx.fetchFn(
      "https://enter.pollinations.ai/account/balance",
      {
        headers: {
          Authorization: `Bearer ${ctx.token}`,
        },
        signal: AbortSignal.timeout(ctx.timeoutMs),
      },
    );
    if (!response.ok) return null;
    const body = (await response.json()) as Record<string, unknown>;
    const balance = typeof body.balance === "number" ? body.balance : undefined;
    if (balance === undefined) return null;
    return { balance };
  } catch {
    return null;
  }
}
