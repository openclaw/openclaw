import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  SELF_HOSTED_DEFAULT_CONTEXT_WINDOW,
  SELF_HOSTED_DEFAULT_COST,
  SELF_HOSTED_DEFAULT_MAX_TOKENS,
} from "openclaw/plugin-sdk/provider-setup";
import { asPositiveSafeInteger } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeLlamaServerProviderConfig, resolveLlamaServerEndpoint } from "./endpoint.js";

type LlamaServerModelStatus =
  | "unloaded"
  | "loading"
  | "loaded"
  | "sleeping"
  | "downloading"
  | "unknown";

type LlamaServerModelWire = Record<string, unknown> & {
  id?: unknown;
  object?: unknown;
  status?: {
    value?: unknown;
    failed?: unknown;
  };
  architecture?: {
    input_modalities?: unknown;
  };
};

type LlamaServerPropsWire = Record<string, unknown> & {
  n_ctx?: unknown;
  default_generation_settings?: {
    n_ctx?: unknown;
    params?: {
      max_tokens?: unknown;
      n_predict?: unknown;
    };
  };
  chat_template_caps?: Record<string, unknown>;
  modalities?: Record<string, unknown>;
};

export type LlamaServerDiscoveredModel = {
  config: ModelDefinitionConfig;
  status: LlamaServerModelStatus;
  failed: boolean;
};

function normalizeStatus(value: unknown): LlamaServerModelStatus {
  switch (value) {
    case "unloaded":
    case "loading":
    case "loaded":
    case "sleeping":
    case "downloading":
      return value;
    default:
      return "unknown";
  }
}

function resolveMaxTokens(props: LlamaServerPropsWire | undefined, contextWindow: number): number {
  const params = props?.default_generation_settings?.params;
  const advertised =
    asPositiveSafeInteger(params?.max_tokens) ?? asPositiveSafeInteger(params?.n_predict);
  return Math.min(advertised ?? SELF_HOSTED_DEFAULT_MAX_TOKENS, contextWindow);
}

function resolveInput(
  row: LlamaServerModelWire,
  props: LlamaServerPropsWire | undefined,
): Array<"text" | "image"> {
  const advertised = row.architecture?.input_modalities;
  const supportsImage =
    (Array.isArray(advertised) && advertised.includes("image")) ||
    props?.modalities?.vision === true;
  return supportsImage ? ["text", "image"] : ["text"];
}

function buildCompat(
  props: LlamaServerPropsWire | undefined,
  useRuntimeDefaults: boolean,
): NonNullable<ModelDefinitionConfig["compat"]> {
  const caps = props?.chat_template_caps;
  return {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: caps?.supports_reasoning_effort === true,
    supportsTemperature: true,
    supportsUsageInStreaming: true,
    ...(typeof caps?.supports_tool_calls === "boolean" || useRuntimeDefaults
      ? { supportsTools: caps?.supports_tool_calls === true }
      : {}),
    supportsStrictMode: false,
    supportsJsonSchemaResponseFormat: true,
    requiresStringContent: caps?.supports_typed_content !== true,
    maxTokensField: "max_tokens",
  };
}

/** Maps one llama-server model row plus optional runtime properties into OpenClaw config. */
export function mapLlamaServerModel(
  row: LlamaServerModelWire,
  props?: LlamaServerPropsWire,
  useRuntimeDefaults = true,
): LlamaServerDiscoveredModel | null {
  const id = typeof row.id === "string" ? row.id.trim() : "";
  if (!id || (row.object !== undefined && row.object !== "model")) {
    return null;
  }
  // Setup must not turn an unverified runtime fallback into an authored override.
  const contextWindow =
    asPositiveSafeInteger(props?.default_generation_settings?.n_ctx) ??
    asPositiveSafeInteger(props?.n_ctx) ??
    (useRuntimeDefaults ? SELF_HOSTED_DEFAULT_CONTEXT_WINDOW : undefined);
  const compat = buildCompat(props, useRuntimeDefaults);
  return {
    config: {
      id,
      name: id,
      reasoning: compat.supportsReasoningEffort === true,
      input: resolveInput(row, props),
      cost: { ...SELF_HOSTED_DEFAULT_COST },
      contextWindow,
      contextTokens: contextWindow,
      maxTokens: resolveMaxTokens(props, contextWindow ?? SELF_HOSTED_DEFAULT_CONTEXT_WINDOW),
      compat,
    },
    status: normalizeStatus(row.status?.value),
    failed: row.status?.failed === true,
  };
}

export function buildLlamaServerProviderConfig(params: {
  configured?: ModelProviderConfig;
  discoveredModels: readonly LlamaServerDiscoveredModel[];
}): ModelProviderConfig {
  const baseUrl = resolveLlamaServerEndpoint(params.configured?.baseUrl).inferenceBaseUrl;
  const discoveredById = new Map(params.discoveredModels.map(({ config }) => [config.id, config]));
  const models = (params.configured?.models ?? []).map((configured) => {
    const discovered = discoveredById.get(configured.id);
    discoveredById.delete(configured.id);
    const matchesRoute =
      (!configured.api || configured.api === "openai-completions") &&
      resolveLlamaServerEndpoint(configured.baseUrl?.trim() || baseUrl).inferenceBaseUrl ===
        baseUrl;
    return discovered && matchesRoute
      ? Object.assign({}, discovered, configured, {
          contextWindow: configured.contextWindow ?? discovered.contextWindow,
          contextTokens: configured.contextTokens ?? discovered.contextTokens,
          compat: { ...discovered.compat, ...configured.compat },
        })
      : configured;
  });
  models.push(...discoveredById.values());
  return normalizeLlamaServerProviderConfig({
    ...params.configured,
    baseUrl,
    models,
  });
}
