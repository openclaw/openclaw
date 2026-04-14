import type { ProviderAuthMethodNonInteractiveContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  upsertAuthProfileWithLock,
  applyAuthProfileConfig,
  normalizeOptionalSecretInput,
} from "openclaw/plugin-sdk/provider-auth";
import type {
  OpenClawConfig,
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import { applyAgentDefaultModelPrimary } from "openclaw/plugin-sdk/provider-onboard";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  applyLitellmConfig,
  buildLitellmModelDefinition,
  LITELLM_BASE_URL,
  LITELLM_DEFAULT_MODEL_ID,
} from "../onboard.js";

type LitellmModel = {
  id: string;
  object?: string;
  owned_by?: string;
};

type LitellmModelsResponse = {
  data?: LitellmModel[];
};

function buildLitellmSsrfPolicy(baseUrl: string) {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return {
      allowedHostnames: [parsed.hostname],
      hostnameAllowlist: [parsed.hostname],
    };
  } catch {
    return undefined;
  }
}

export async function fetchLitellmModels(
  baseUrl: string,
  apiKey?: string,
): Promise<{ reachable: boolean; models: string[] }> {
  try {
    // Strip a trailing `/v1` so OpenAI-style base URLs don't become `/v1/v1/models`.
    const normalized = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
    const url = `${normalized}/v1/models`;
    const headers: Record<string, string> = {};
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }
    const { response, release } = await fetchWithSsrFGuard({
      url,
      init: {
        signal: AbortSignal.timeout(5000),
        headers,
      },
      policy: buildLitellmSsrfPolicy(baseUrl),
      auditContext: "litellm-provider-models.list",
    });
    try {
      if (!response.ok) {
        // Treat HTTP errors (401/403/5xx) as unreachable so transient auth or
        // proxy failures don't collapse an existing catalog to the empty set.
        return { reachable: false, models: [] };
      }
      const data = (await response.json()) as LitellmModelsResponse;
      const models = (data.data ?? []).map((m) => m.id).filter(Boolean);
      return { reachable: true, models };
    } finally {
      await release();
    }
  } catch {
    return { reachable: false, models: [] };
  }
}

function applyLitellmProviderWithModels(
  cfg: OpenClawConfig,
  baseUrl: string,
  discoveredModelIds: string[],
): OpenClawConfig {
  const defaultModel = buildLitellmModelDefinition();
  // Default to permissive capabilities (reasoning + image input) since LiteLLM
  // proxies typically front capable models and the /v1/models response does not
  // include capability metadata.
  const defaultDiscoveredModel: ModelDefinitionConfig = {
    id: "",
    name: "",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
  const existingProvider = cfg.models?.providers?.litellm;
  // Preserve any previously curated metadata (contextWindow, input, cost, ...)
  // for models that are still present on the proxy. Drops entries that are no
  // longer discovered so stale models are not kept alive across re-runs.
  const existingById = new Map<string, ModelDefinitionConfig>();
  for (const m of existingProvider?.models ?? []) {
    if (m?.id) {
      existingById.set(m.id, m);
    }
  }
  const models: ModelDefinitionConfig[] = discoveredModelIds.map((id) => {
    if (id === defaultModel.id) {
      return defaultModel;
    }
    const prior = existingById.get(id);
    return prior
      ? { ...defaultDiscoveredModel, ...prior, id, name: prior.name ?? id }
      : { ...defaultDiscoveredModel, id, name: id };
  });
  // Always include the default model definition even if not discovered.
  if (!discoveredModelIds.includes(defaultModel.id)) {
    models.push(defaultModel);
  }
  return {
    ...cfg,
    models: {
      ...cfg.models,
      mode: cfg.models?.mode ?? "merge",
      providers: {
        ...cfg.models?.providers,
        litellm: {
          ...existingProvider,
          baseUrl,
          api: "openai-completions",
          apiKey: "LITELLM_API_KEY",
          models,
        },
      },
    },
  };
}

export async function configureLitellmNonInteractive(ctx: ProviderAuthMethodNonInteractiveContext) {
  const customBaseUrl = normalizeOptionalSecretInput(ctx.opts.customBaseUrl);
  // Precedence: CLI flag > existing configured baseUrl > default. Avoids
  // overwriting a remote proxy with localhost when onboarding is re-run
  // without --custom-base-url (for example, to refresh the API key).
  const existingBaseUrl = ctx.config.models?.providers?.litellm?.baseUrl;
  const baseUrl = (
    customBaseUrl?.trim() ||
    (typeof existingBaseUrl === "string" && existingBaseUrl.trim()) ||
    LITELLM_BASE_URL
  ).replace(/\/+$/, "");
  const customModelId = normalizeOptionalSecretInput(ctx.opts.customModelId);

  // Resolve API key through the standard flow.
  const resolved = await ctx.resolveApiKey({
    provider: "litellm",
    flagValue: normalizeOptionalSecretInput(ctx.opts.litellmApiKey),
    flagName: "--litellm-api-key",
    envVar: "LITELLM_API_KEY",
  });
  if (!resolved) {
    return null;
  }

  // Store credential. Skip when the key came from an existing profile to avoid
  // downgrading env-ref/keychain-backed profile semantics to plaintext — matches
  // the default provider-api-key-auth behavior.
  if (resolved.source !== "profile") {
    const credential = ctx.toApiKeyCredential({
      provider: "litellm",
      resolved,
    });
    if (!credential) {
      return null;
    }
    await upsertAuthProfileWithLock({
      profileId: "litellm:default",
      credential,
      agentDir: ctx.agentDir,
    });
  }

  // Discover available models from the proxy.
  const { reachable, models: discoveredModelIds } = await fetchLitellmModels(baseUrl, resolved.key);

  if (!reachable) {
    ctx.runtime.log(
      `LiteLLM proxy not reachable at ${baseUrl}; using default model configuration.`,
    );
    // Fall back to the preset applier with the explicit base URL written into
    // config so resolveParams picks it up instead of defaulting to localhost.
    const withBaseUrl: OpenClawConfig = {
      ...ctx.config,
      models: {
        ...ctx.config.models,
        providers: {
          ...ctx.config.models?.providers,
          // Inject baseUrl so applyLitellmConfig's resolveParams picks it up.
          // The shape is intentionally partial — applyLitellmConfig fills the rest.
          litellm: {
            ...ctx.config.models?.providers?.litellm,
            baseUrl,
          } as ModelProviderConfig,
        },
      },
    };
    let next = applyAuthProfileConfig(withBaseUrl, {
      profileId: "litellm:default",
      provider: "litellm",
      mode: "api_key",
    });
    next = applyLitellmConfig(next);
    const fallbackModelId = customModelId ?? LITELLM_DEFAULT_MODEL_ID;
    // Ensure customModelId is present in the provider model list so the primary
    // ref resolves even when the proxy is offline and discovery was skipped.
    if (customModelId && customModelId !== LITELLM_DEFAULT_MODEL_ID) {
      const provider = next.models?.providers?.litellm;
      const existingModels = provider?.models ?? [];
      if (!existingModels.some((m) => m?.id === customModelId)) {
        next = {
          ...next,
          models: {
            ...next.models,
            providers: {
              ...next.models?.providers,
              litellm: {
                ...provider,
                models: [
                  ...existingModels,
                  { ...buildLitellmModelDefinition(), id: customModelId, name: customModelId },
                ],
              } as ModelProviderConfig,
            },
          },
        };
      }
    }
    return applyAgentDefaultModelPrimary(next, `litellm/${fallbackModelId}`);
  }

  // Resolve default model.
  const defaultModelId = customModelId ?? pickDefaultModel(discoveredModelIds);

  // Ensure the chosen model appears in the model list so the primary ref resolves.
  const allModelIds =
    customModelId && !discoveredModelIds.includes(customModelId)
      ? [...discoveredModelIds, customModelId]
      : discoveredModelIds;

  // Build config with discovered (+ custom) models.
  let next = applyLitellmProviderWithModels(ctx.config, baseUrl, allModelIds);
  next = applyAuthProfileConfig(next, {
    profileId: "litellm:default",
    provider: "litellm",
    mode: "api_key",
  });

  ctx.runtime.log(`Default LiteLLM model: ${defaultModelId}`);
  if (discoveredModelIds.length > 0) {
    ctx.runtime.log(`Discovered ${discoveredModelIds.length} model(s) from LiteLLM proxy.`);
  }
  return applyAgentDefaultModelPrimary(next, `litellm/${defaultModelId}`);
}

function pickDefaultModel(discoveredModelIds: string[]): string {
  if (discoveredModelIds.length === 0) {
    return LITELLM_DEFAULT_MODEL_ID;
  }
  // Prefer the built-in default if it exists in discovered models.
  if (discoveredModelIds.includes(LITELLM_DEFAULT_MODEL_ID)) {
    return LITELLM_DEFAULT_MODEL_ID;
  }
  return discoveredModelIds[0];
}
