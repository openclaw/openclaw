import {
  applyAgentDefaultModelPrimary,
  applyProviderConfigWithDefaultModel,
  applyProviderConnectionConfig,
  createAliasOnlyPresetAppliers,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  buildCloudflareAiGatewayModelDefinition,
  CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF,
  resolveCloudflareAiGatewayBaseUrl,
} from "./models.js";

const { applyProviderConfig: applyCloudflareAiGatewayAlias } = createAliasOnlyPresetAppliers({
  modelRef: CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF,
  alias: "Cloudflare AI Gateway",
});

export function buildCloudflareAiGatewayConfigPatch(params: {
  accountId: string;
  gatewayId: string;
}) {
  const baseUrl = resolveCloudflareAiGatewayBaseUrl(params);
  return {
    models: {
      providers: {
        "cloudflare-ai-gateway": {
          baseUrl,
          api: "anthropic-messages" as const,
          models: [buildCloudflareAiGatewayModelDefinition()],
        },
      },
    },
    agents: {
      defaults: {
        models: {
          [CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF]: {
            alias: "Cloudflare AI Gateway",
          },
        },
      },
    },
  };
}

export function applyCloudflareAiGatewayProviderConfig(
  cfg: OpenClawConfig,
  params?: { accountId?: string; gatewayId?: string },
): OpenClawConfig {
  const withAlias = applyCloudflareAiGatewayAlias(cfg);
  const existingProvider = cfg.models?.providers?.["cloudflare-ai-gateway"];
  const baseUrl =
    params?.accountId && params?.gatewayId
      ? resolveCloudflareAiGatewayBaseUrl({
          accountId: params.accountId,
          gatewayId: params.gatewayId,
        })
      : typeof existingProvider?.baseUrl === "string"
        ? existingProvider.baseUrl
        : undefined;
  if (!baseUrl) {
    return withAlias;
  }

  return applyProviderConfigWithDefaultModel(cfg, {
    agentModels: withAlias.agents?.defaults?.models ?? {},
    providerId: "cloudflare-ai-gateway",
    api: "anthropic-messages",
    baseUrl,
    defaultModel: buildCloudflareAiGatewayModelDefinition(),
  });
}

export function applyCloudflareAiGatewayConfig(
  cfg: OpenClawConfig,
  params?: { accountId?: string; gatewayId?: string },
): OpenClawConfig {
  return applyAgentDefaultModelPrimary(
    applyCloudflareAiGatewayProviderConfig(cfg, params),
    CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF,
  );
}

/** Registered setup keeps authored rows and seeds the default only in replace mode. */
export function applyCloudflareAiGatewayProviderConnectionConfig(
  cfg: OpenClawConfig,
  params: { accountId: string; gatewayId: string },
): OpenClawConfig {
  return applyProviderConnectionConfig(cfg, {
    providerId: "cloudflare-ai-gateway",
    api: "anthropic-messages",
    baseUrl: resolveCloudflareAiGatewayBaseUrl(params),
    catalogModels: () => [buildCloudflareAiGatewayModelDefinition()],
    aliases: [
      { modelRef: CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF, alias: "Cloudflare AI Gateway" },
    ],
  });
}

export function applyCloudflareAiGatewayConnectionConfig(
  cfg: OpenClawConfig,
  params: { accountId: string; gatewayId: string },
): OpenClawConfig {
  return applyAgentDefaultModelPrimary(
    applyCloudflareAiGatewayProviderConnectionConfig(cfg, params),
    CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF,
  );
}
