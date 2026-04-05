import {
  applyAgentDefaultModelPrimary,
  applyProviderConfigWithDefaultModel,
  type MullusiConfig,
} from "mullusi/plugin-sdk/provider-onboard";
import {
  buildCloudflareAiGatewayModelDefinition,
  CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF,
  resolveCloudflareAiGatewayBaseUrl,
} from "./models.js";

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
  cfg: MullusiConfig,
  params?: { accountId?: string; gatewayId?: string },
): MullusiConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF] = {
    ...models[CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF],
    alias: models[CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF]?.alias ?? "Cloudflare AI Gateway",
  };

  const existingProvider = cfg.models?.providers?.["cloudflare-ai-gateway"] as
    | { baseUrl?: unknown }
    | undefined;
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
    return {
      ...cfg,
      agents: {
        ...cfg.agents,
        defaults: {
          ...cfg.agents?.defaults,
          models,
        },
      },
    };
  }

  return applyProviderConfigWithDefaultModel(cfg, {
    agentModels: models,
    providerId: "cloudflare-ai-gateway",
    api: "anthropic-messages",
    baseUrl,
    defaultModel: buildCloudflareAiGatewayModelDefinition(),
  });
}

export function applyCloudflareAiGatewayConfig(
  cfg: MullusiConfig,
  params?: { accountId?: string; gatewayId?: string },
): MullusiConfig {
  return applyAgentDefaultModelPrimary(
    applyCloudflareAiGatewayProviderConfig(cfg, params),
    CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF,
  );
}
