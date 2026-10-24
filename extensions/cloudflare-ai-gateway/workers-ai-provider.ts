import type { ProviderPlugin } from "openclaw/plugin-sdk/plugin-entry";
import {
  createProviderApiKeyAuthMethod,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-auth-api-key";
import { normalizeModelCatalog } from "openclaw/plugin-sdk/provider-model-metadata";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const PROVIDER_ID = "cloudflare-workers-ai";
const CLEF_INFERENCE = normalizeModelCatalog(manifest.modelCatalog, {
  ownedProviders: new Set([PROVIDER_ID]),
})?.providers?.[PROVIDER_ID]?.models.find((model) => model.id === "@cf/cloudflare/clef")?.inference;

function configuredBaseUrl(config: OpenClawConfig, accountId: unknown): string | undefined {
  const account = normalizeOptionalString(accountId);
  return account
    ? `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/ai`
    : normalizeOptionalString(config.models?.providers?.[PROVIDER_ID]?.baseUrl);
}

function applyConnection(config: OpenClawConfig, baseUrl: string): OpenClawConfig {
  const existing = config.models?.providers?.[PROVIDER_ID];
  return {
    ...config,
    models: {
      ...config.models,
      providers: {
        ...config.models?.providers,
        [PROVIDER_ID]: { ...existing, baseUrl, models: existing?.models ?? [] },
      },
    },
  };
}

export function buildWorkersAiProvider(): ProviderPlugin {
  const auth = createProviderApiKeyAuthMethod({
    providerId: PROVIDER_ID,
    methodId: "api-key",
    label: "Cloudflare Workers AI API token",
    optionKey: "cloudflareWorkersAiApiToken",
    flagName: "--cloudflare-workers-ai-api-token",
    envVar: "CLOUDFLARE_WORKERS_AI_API_TOKEN",
    promptMessage: "Enter Cloudflare API token with Workers AI Read permission",
  });
  const requireBaseUrl = (config: OpenClawConfig, accountId: unknown) => {
    const baseUrl = configuredBaseUrl(config, accountId);
    if (!baseUrl) {
      throw new Error(
        "Cloudflare Workers AI setup requires --cloudflare-ai-gateway-account-id or models.providers.cloudflare-workers-ai.baseUrl.",
      );
    }
    return baseUrl;
  };
  return {
    id: PROVIDER_ID,
    label: "Cloudflare Workers AI",
    docsPath: "/providers/cloudflare-ai-gateway#clef-decision-model",
    envVars: ["CLOUDFLARE_WORKERS_AI_API_TOKEN"],
    augmentModelCatalog: ({ config, entries }) =>
      entries
        .filter((entry) => entry.provider === PROVIDER_ID && entry.id === "@cf/cloudflare/clef")
        .map((entry) => {
          const configured = config?.models?.providers?.[PROVIDER_ID];
          const baseUrl =
            configured?.models?.find((model) => model.id === entry.id)?.baseUrl ??
            configured?.baseUrl ??
            entry.baseUrl;
          const url = baseUrl ? URL.parse(baseUrl) : null;
          const native =
            url?.origin === "https://api.cloudflare.com" &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash &&
            /^\/client\/v4\/accounts\/[^/]+\/ai\/?$/.test(url.pathname);
          // Configured rows lose route-bound inference before the account URL is
          // projected. Restore this provider's declaration, not a chat transport.
          const inference = entry.inference?.decision ? entry.inference : CLEF_INFERENCE;
          const decision = inference?.decision;
          // Account routes have no static manifest URL. Bind the endpoint before
          // auth/dispatch; custom routes must not inherit Cloudflare's hosted prices.
          if (!native && inference && decision?.billing) {
            const { billing: _billing, ...capabilities } = decision;
            return Object.assign({}, entry, {
              baseUrl,
              inference: { ...inference, decision: capabilities },
            });
          }
          return Object.assign({}, entry, { baseUrl, inference });
        }),
    auth: [
      {
        ...auth,
        async run(ctx) {
          // The existing account flag identifies the Cloudflare account only. Keys,
          // profiles and endpoint configuration stay separate from Anthropic Gateway.
          let baseUrl = configuredBaseUrl(ctx.config, ctx.opts?.cloudflareAiGatewayAccountId);
          if (!baseUrl) {
            const accountId = await ctx.prompter.text({
              message: "Enter Cloudflare Account ID",
              validate: (value) =>
                normalizeOptionalString(value) ? undefined : "Account ID is required",
            });
            baseUrl = requireBaseUrl(ctx.config, accountId);
          }
          const result = await auth.run(ctx);
          return { ...result, configPatch: applyConnection(ctx.config, baseUrl) };
        },
        async validateNonInteractive(ctx) {
          requireBaseUrl(ctx.config, ctx.opts.cloudflareAiGatewayAccountId);
          return auth.validateNonInteractive!(ctx);
        },
        async runNonInteractive(ctx) {
          const baseUrl = requireBaseUrl(ctx.config, ctx.opts.cloudflareAiGatewayAccountId);
          const config = await auth.runNonInteractive!(ctx);
          return config ? applyConnection(config, baseUrl) : null;
        },
      },
    ],
  };
}
