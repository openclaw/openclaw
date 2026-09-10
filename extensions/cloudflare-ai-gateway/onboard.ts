/**
 * Config patch helpers used by Cloudflare AI Gateway interactive and
 * non-interactive onboarding flows.
 */
import {
  applyAgentDefaultModelPrimary,
  applyProviderConfigWithDefaultModel,
  applyProviderConnectionConfig,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  buildCloudflareAiGatewayModelDefinition,
  CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF,
  resolveCloudflareAiGatewayBaseUrl,
} from "./models.js";

/**
 * Builds the minimal config patch for provider setup and default model aliasing.
 */
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

/**
 * Applies provider model config while preserving existing agent model aliases.
 */
export function applyCloudflareAiGatewayProviderConfig(
  cfg: OpenClawConfig,
  params?: { accountId?: string; gatewayId?: string },
): OpenClawConfig {
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

/**
 * Applies Cloudflare AI Gateway config and makes its default model primary.
 */
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
