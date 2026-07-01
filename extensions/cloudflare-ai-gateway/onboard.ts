/**
 * Config patch helpers used by Cloudflare AI Gateway interactive and
 * non-interactive onboarding flows.
 */
import {
  applyAgentDefaultModelPrimary,
  applyProviderConfigWithModelCatalog,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  buildCloudflareAiGatewayModelDefinitions,
  CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF,
  CLOUDFLARE_AI_GATEWAY_PROVIDER_ID,
  resolveCloudflareAiGatewayBaseUrl,
} from "./models.js";

type AgentModelMap = NonNullable<
  NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>["models"]
>;

function withCloudflareAiGatewayAgentModels(existing: AgentModelMap | undefined) {
  const models = { ...existing };
  for (const model of buildCloudflareAiGatewayModelDefinitions()) {
    const modelRef = `${CLOUDFLARE_AI_GATEWAY_PROVIDER_ID}/${model.id}`;
    models[modelRef] = { ...models[modelRef] };
  }
  models[CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF] = {
    ...models[CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF],
    alias: models[CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF]?.alias ?? "Cloudflare AI Gateway",
  };
  return models;
}

/**
 * Builds the minimal config patch for provider setup and default model aliasing.
 */
export function buildCloudflareAiGatewayConfigPatch(
  params: {
    accountId: string;
    gatewayId: string;
  },
  cfg: OpenClawConfig = {},
) {
  const baseUrl = resolveCloudflareAiGatewayBaseUrl(params);
  const next = applyCloudflareAiGatewayProviderConfig(cfg, params);
  const provider = next.models?.providers?.["cloudflare-ai-gateway"] ?? {
    baseUrl,
    api: "anthropic-messages" as const,
    models: buildCloudflareAiGatewayModelDefinitions(),
  };
  const nextAgentModels = next.agents?.defaults?.models;
  const agentModels = Object.fromEntries(
    buildCloudflareAiGatewayModelDefinitions().map((model) => {
      const modelRef = `${CLOUDFLARE_AI_GATEWAY_PROVIDER_ID}/${model.id}`;
      return [modelRef, nextAgentModels?.[modelRef] ?? {}];
    }),
  );
  return {
    models: {
      providers: {
        "cloudflare-ai-gateway": provider,
      },
    },
    agents: {
      defaults: {
        models: agentModels,
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
  const models = withCloudflareAiGatewayAgentModels(cfg.agents?.defaults?.models);

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

  return applyProviderConfigWithModelCatalog(cfg, {
    agentModels: models,
    providerId: "cloudflare-ai-gateway",
    api: "anthropic-messages",
    baseUrl,
    catalogModels: buildCloudflareAiGatewayModelDefinitions(),
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
