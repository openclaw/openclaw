// Migrate Hermes helper module supports config behavior.
import {
  applyMigrationConfigPatchItem,
  applyMigrationManualItem,
  createMigrationConfigPatchItem,
  createMigrationManualItem,
  hasMigrationConfigPatchConflict,
} from "openclaw/plugin-sdk/migration";
import type { MigrationItem, MigrationProviderContext } from "openclaw/plugin-sdk/plugin-entry";
import { childRecord, isRecord, readString, readStringArray, sanitizeName } from "./helpers.js";
import {
  normalizeHermesCustomProviderId,
  normalizeHermesProviderId,
  resolveHermesConfiguredProviderId,
} from "./model.js";

type OpenClawModelApi =
  | "anthropic-messages"
  | "openai-completions"
  | "openai-responses"
  | "openai-chatgpt-responses";

type HermesModelConfig = {
  id: string;
  contextWindow?: number;
  maxTokens?: number;
  supportsVision?: boolean;
};

type HermesProviderConfig = {
  id: string;
  baseUrl: string;
  api: OpenClawModelApi;
  apiKeyEnv?: string;
  headers?: Record<string, unknown>;
  models: HermesModelConfig[];
  sensitive?: boolean;
};

export type HermesProviderSecretBinding = {
  envVar: string;
  provider: string;
};

type HermesProviderSource = {
  id: string;
  raw: Record<string, unknown>;
  source: string;
};

const HERMES_TRANSPORTS: Record<string, OpenClawModelApi> = {
  anthropic_messages: "anthropic-messages",
  chat_completions: "openai-completions",
  codex_responses: "openai-responses",
  openai_chat: "openai-completions",
};
const HERMES_MOONSHOT_CN_BASE_URL = "https://api.moonshot.cn/v1";
const HERMES_MINIMAX_CN_BASE_URL = "https://api.minimaxi.com/anthropic";
const HERMES_ALIBABA_BASE_URL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";

const HERMES_SPECIAL_BASE_URL_ENV_VARS: Record<string, readonly string[]> = {
  // Hermes plain `custom` still reads OPENAI_BASE_URL in its runtime provider resolver.
  custom: ["CUSTOM_BASE_URL", "OPENAI_BASE_URL"],
  "openai-api": ["OPENAI_BASE_URL"],
  "xai-oauth": ["HERMES_XAI_BASE_URL", "XAI_BASE_URL"],
  "qwen-oauth": ["HERMES_QWEN_BASE_URL"],
  "minimax-cn": ["MINIMAX_CN_BASE_URL"],
  "alibaba-coding-plan": ["ALIBABA_CODING_PLAN_BASE_URL"],
};

const HERMES_BASE_URL_ENV_VARS: Record<string, readonly string[]> = {
  anthropic: ["ANTHROPIC_BASE_URL"],
  arcee: ["ARCEE_BASE_URL"],
  "azure-foundry": ["AZURE_FOUNDRY_BASE_URL"],
  deepseek: ["DEEPSEEK_BASE_URL"],
  gmi: ["GMI_BASE_URL"],
  google: ["GEMINI_BASE_URL"],
  huggingface: ["HF_BASE_URL"],
  kilocode: ["KILOCODE_BASE_URL"],
  kimi: ["KIMI_BASE_URL"],
  lmstudio: ["LM_BASE_URL"],
  minimax: ["MINIMAX_BASE_URL"],
  novita: ["NOVITA_BASE_URL"],
  nvidia: ["NVIDIA_BASE_URL"],
  "ollama-cloud": ["OLLAMA_BASE_URL"],
  opencode: ["OPENCODE_ZEN_BASE_URL"],
  "opencode-go": ["OPENCODE_GO_BASE_URL"],
  openrouter: ["OPENROUTER_BASE_URL"],
  qwen: ["DASHSCOPE_BASE_URL"],
  stepfun: ["STEPFUN_BASE_URL"],
  "tencent-tokenhub": ["TOKENHUB_BASE_URL"],
  xai: ["XAI_BASE_URL"],
  xiaomi: ["XIAOMI_BASE_URL"],
  zai: ["GLM_BASE_URL"],
};

const HERMES_SPECIAL_API_KEY_ENV_VARS: Record<string, string> = {
  custom: "OPENAI_API_KEY",
  "openai-api": "OPENAI_API_KEY",
  "minimax-cn": "MINIMAX_CN_API_KEY",
  "alibaba-coding-plan": "ALIBABA_CODING_PLAN_API_KEY",
};

const HERMES_API_KEY_ENV_VARS: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  arcee: "ARCEEAI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  google: "GOOGLE_API_KEY",
  huggingface: "HF_TOKEN",
  kilocode: "KILOCODE_API_KEY",
  kimi: "KIMI_API_KEY",
  lmstudio: "LM_API_KEY",
  minimax: "MINIMAX_API_KEY",
  nvidia: "NVIDIA_API_KEY",
  opencode: "OPENCODE_ZEN_API_KEY",
  "opencode-go": "OPENCODE_GO_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  qwen: "DASHSCOPE_API_KEY",
  stepfun: "STEPFUN_API_KEY",
  xai: "XAI_API_KEY",
  xiaomi: "XIAOMI_API_KEY",
  zai: "ZAI_API_KEY",
};

function resolveHermesProviderEnvValue(
  providerId: string | undefined,
  env: Record<string, string>,
  special: Record<string, readonly string[]>,
  canonical: Record<string, readonly string[]>,
): string | undefined {
  if (!providerId) {
    return undefined;
  }
  const sourceProvider = normalizeHermesCustomProviderId(providerId);
  const provider = normalizeHermesProviderId(sourceProvider);
  const names = special[sourceProvider] ?? canonical[provider] ?? [];
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

function resolveHermesProviderBaseUrlEnv(
  providerId: string | undefined,
  env: Record<string, string>,
): string | undefined {
  return resolveHermesProviderEnvValue(
    providerId,
    env,
    HERMES_SPECIAL_BASE_URL_ENV_VARS,
    HERMES_BASE_URL_ENV_VARS,
  );
}

function resolveHermesProviderApiKeyEnv(providerId: string | undefined): string | undefined {
  if (!providerId) {
    return undefined;
  }
  const sourceProvider = normalizeHermesCustomProviderId(providerId);
  const provider = normalizeHermesProviderId(sourceProvider);
  return HERMES_SPECIAL_API_KEY_ENV_VARS[sourceProvider] ?? HERMES_API_KEY_ENV_VARS[provider];
}

function resolveHermesImplicitBaseUrl(providerId: string | undefined): string | undefined {
  const provider = providerId?.trim().toLowerCase();
  if (provider && ["alibaba", "alibaba-cloud", "aliyun", "dashscope"].includes(provider)) {
    return HERMES_ALIBABA_BASE_URL;
  }
  // OpenClaw's qwen default is already Hermes' coding-plan endpoint; no override needed.
  if (provider && ["kimi-coding-cn", "kimi-cn", "moonshot-cn"].includes(provider)) {
    return HERMES_MOONSHOT_CN_BASE_URL;
  }
  return provider && ["minimax-cn", "minimax-china", "minimax_cn"].includes(provider)
    ? HERMES_MINIMAX_CN_BASE_URL
    : undefined;
}

function readPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function resolveProviderApi(
  raw: Record<string, unknown>,
  providerId?: string,
): OpenClawModelApi | undefined {
  const transport = readString(raw.transport) ?? readString(raw.api_mode);
  const sourceProvider = providerId?.trim().toLowerCase() ?? "";
  if (sourceProvider === "openai-codex") {
    return "openai-chatgpt-responses";
  }
  if (transport && transport !== "codex_responses") {
    return HERMES_TRANSPORTS[transport];
  }
  const provider = sourceProvider ? normalizeHermesProviderId(sourceProvider) : "";
  const baseUrl =
    readString(raw.base_url) ??
    readString(raw.baseUrl) ??
    readString(raw.url) ??
    readString(raw.api);
  let hostname = "";
  let pathname = "";
  try {
    const parsed = baseUrl ? new URL(baseUrl) : undefined;
    hostname = parsed?.hostname.toLowerCase() ?? "";
    pathname = parsed?.pathname.toLowerCase().replace(/\/+$/u, "") ?? "";
  } catch {
    // Provider identity still supplies the protocol for templated endpoints.
  }
  // Hermes honors an explicit Responses mode for named providers. Plain
  // `custom` is the exception: endpoint detection rejects stale Responses state.
  if (transport === "codex_responses" && sourceProvider !== "custom") {
    return "openai-responses";
  }
  if (
    ["anthropic", "minimax", "minimax-cn", "minimax-oauth"].includes(provider) ||
    hostname === "api.anthropic.com" ||
    (hostname === "api.kimi.com" && (pathname === "/coding" || pathname.startsWith("/coding/"))) ||
    pathname.endsWith("/anthropic") ||
    pathname.endsWith("/anthropic/v1")
  ) {
    return "anthropic-messages";
  }
  if (hostname === "chatgpt.com" && pathname.includes("/backend-api/codex")) {
    return "openai-chatgpt-responses";
  }
  if (sourceProvider === "openai-api") {
    return "openai-responses";
  }
  if (transport === "codex_responses") {
    return "openai-responses";
  }
  if (provider === "xai" || hostname === "api.x.ai" || hostname === "api.openai.com") {
    return "openai-responses";
  }
  return "openai-completions";
}

function normalizeProviderBaseUrl(baseUrl: string, api: OpenClawModelApi): string {
  if (api !== "anthropic-messages") {
    return baseUrl;
  }
  try {
    const parsed = new URL(baseUrl);
    // The Anthropic SDK appends /v1/messages. Store the canonical base so
    // imported proxy paths do not repeat the version segment.
    parsed.pathname = parsed.pathname.replace(/\/v1\/?$/u, "");
    return parsed.toString().replace(/\/$/u, "");
  } catch {
    return baseUrl;
  }
}

function readEnvReference(value: unknown): string | undefined {
  const raw = readString(value);
  const match = raw?.match(/^\$\{([^}]+)\}$/u);
  return match ? normalizeHermesEnvReferenceName(match[1] ?? "") : undefined;
}

function normalizeHermesEnvReferenceName(value: string): string | undefined {
  const trimmed = value.trim();
  const name = trimmed.startsWith("env:") ? trimmed.slice("env:".length).trim() : trimmed;
  return name || undefined;
}

function readProviderApiKeyEnv(raw: Record<string, unknown>): string | undefined {
  return (
    readString(raw.key_env) ??
    readString(raw.api_key_env) ??
    readString(raw.apiKeyEnv) ??
    readString(raw.env) ??
    readEnvReference(raw.api_key)
  );
}

function resolveHermesEndpointApiKeyEnv(baseUrl: string): string | undefined {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === "openai.com" ||
      hostname.endsWith(".openai.com") ||
      hostname === "openai.azure.com" ||
      hostname.endsWith(".openai.azure.com")
      ? "OPENAI_API_KEY"
      : undefined;
  } catch {
    return undefined;
  }
}

function readModelMetadata(raw: Record<string, unknown>): Omit<HermesModelConfig, "id"> {
  const contextWindow =
    readPositiveNumber(raw.context_length) ?? readPositiveNumber(raw.contextWindow);
  const maxTokens =
    readPositiveNumber(raw.max_tokens) ??
    readPositiveNumber(raw.max_output_tokens) ??
    readPositiveNumber(raw.maxTokens);
  const supportsVision = raw.supports_vision ?? raw.supportsVision;
  return {
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxTokens ? { maxTokens } : {}),
    ...(typeof supportsVision === "boolean" ? { supportsVision } : {}),
  };
}

function collectProviderModels(raw: Record<string, unknown>): HermesModelConfig[] {
  const models = new Map<string, HermesModelConfig>();
  const rootMetadata = readModelMetadata(raw);
  for (const modelId of readStringArray(raw.models)) {
    models.set(modelId, { id: modelId, ...rootMetadata });
  }
  for (const [modelId, metadata] of Object.entries(childRecord(raw, "models"))) {
    models.set(modelId, {
      id: modelId,
      ...rootMetadata,
      ...(isRecord(metadata) ? readModelMetadata(metadata) : {}),
    });
  }
  for (const modelId of [
    readString(raw.default_model),
    readString(raw.default),
    readString(raw.model),
  ]) {
    if (modelId && !models.has(modelId)) {
      models.set(modelId, { id: modelId, ...rootMetadata });
    }
  }
  return [...models.values()];
}

function modelDefinition(
  model: HermesModelConfig,
  entry: HermesProviderConfig,
): Record<string, unknown> {
  const baseUrl = normalizeProviderBaseUrl(entry.baseUrl, entry.api);
  return {
    id: model.id,
    name: model.id,
    api: entry.api,
    reasoning: false,
    input: model.supportsVision ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.contextWindow ?? 128_000,
    maxTokens: model.maxTokens ?? 8192,
    baseUrl,
    metadataSource: "models-add",
  };
}

function providerConfig(entry: HermesProviderConfig): Record<string, unknown> {
  const models = entry.models.length > 0 ? entry.models : [{ id: "default" }];
  return {
    baseUrl: normalizeProviderBaseUrl(entry.baseUrl, entry.api),
    api: entry.api,
    ...(entry.headers ? { headers: entry.headers } : {}),
    models: models.map((model) => modelDefinition(model, entry)),
  };
}

function readProviderBaseUrl(
  raw: Record<string, unknown>,
  env: Record<string, string>,
): { baseUrl?: string; sensitive: boolean; unresolved: boolean } {
  const value =
    readString(raw.base_url) ??
    readString(raw.baseUrl) ??
    readString(raw.url) ??
    readString(raw.api);
  if (!value) {
    return { sensitive: false, unresolved: false };
  }
  const sensitive = MCP_ENV_REFERENCE_RE.test(value);
  MCP_ENV_REFERENCE_RE.lastIndex = 0;
  if (!sensitive) {
    return { baseUrl: value, sensitive: false, unresolved: false };
  }
  const resolved = resolveMcpEnvReferences(value, env);
  return {
    baseUrl:
      !resolved.unresolved && typeof resolved.value === "string" ? resolved.value : undefined,
    sensitive: true,
    unresolved: resolved.unresolved,
  };
}

function readProviderHeaders(
  raw: Record<string, unknown>,
  env: Record<string, string>,
  includeSecrets: boolean,
): {
  blocked: boolean;
  headers?: Record<string, unknown>;
  invalid: boolean;
  sensitive: boolean;
  unresolved: boolean;
} {
  const source = isRecord(raw.extra_headers) ? raw.extra_headers : undefined;
  if (!source || Object.keys(source).length === 0) {
    return { blocked: false, invalid: false, sensitive: false, unresolved: false };
  }
  const headers: Record<string, unknown> = {};
  let blocked = false;
  let invalid = false;
  let sensitive = false;
  let unresolved = false;
  for (const [name, rawValue] of Object.entries(source)) {
    if (rawValue === null || rawValue === undefined) {
      continue;
    }
    if (
      typeof rawValue !== "string" &&
      typeof rawValue !== "number" &&
      typeof rawValue !== "boolean"
    ) {
      invalid = true;
      continue;
    }
    const value = String(rawValue);
    const envName = readEnvReference(value);
    const hasReference = mcpValueHasEnvReferences(value);
    if (!includeSecrets) {
      blocked = true;
      continue;
    }
    sensitive = true;
    if (envName) {
      const resolved = env[envName];
      if (resolved === undefined) {
        unresolved = true;
        continue;
      }
      headers[name] = resolved;
      continue;
    }
    if (hasReference) {
      const resolved = resolveMcpEnvReferences(value, env);
      if (resolved.unresolved || typeof resolved.value !== "string") {
        unresolved = true;
        continue;
      }
      headers[name] = resolved.value;
      continue;
    }
    headers[name] = value;
  }
  return {
    blocked,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    invalid,
    sensitive,
    unresolved,
  };
}

function collectHermesProviders(
  config: Record<string, unknown>,
  env: Record<string, string> = {},
  includeSecrets = false,
): HermesProviderConfig[] {
  const collected: HermesProviderConfig[] = [];
  const upsert = (entry: HermesProviderConfig, options?: { fallbackOnly?: boolean }): void => {
    const index = collected.findIndex((candidate) => candidate.id === entry.id);
    if (index < 0) {
      collected.push(entry);
      return;
    }
    const previous = collected[index]!;
    collected[index] = {
      ...(options?.fallbackOnly ? entry : previous),
      ...(options?.fallbackOnly ? previous : entry),
      models: [
        ...previous.models,
        ...entry.models.filter(
          (model) => !previous.models.some((previousModel) => previousModel.id === model.id),
        ),
      ],
    };
  };
  for (const [id, raw] of Object.entries(childRecord(config, "providers"))) {
    if (!isRecord(raw)) {
      continue;
    }
    const resolvedBaseUrl = readProviderBaseUrl(raw, env);
    const baseUrl = resolvedBaseUrl.baseUrl ?? resolveHermesImplicitBaseUrl(id);
    const api = resolveProviderApi(baseUrl ? { ...raw, base_url: baseUrl } : raw, id);
    if (!baseUrl || !api) {
      continue;
    }
    const headerConfig = readProviderHeaders(raw, env, includeSecrets);
    upsert({
      id: resolveHermesConfiguredProviderId(config, id, env),
      baseUrl,
      api,
      apiKeyEnv: readProviderApiKeyEnv(raw) ?? resolveHermesEndpointApiKeyEnv(baseUrl),
      headers: headerConfig.headers,
      models: collectProviderModels(raw),
      sensitive: resolvedBaseUrl.sensitive || headerConfig.sensitive,
    });
  }

  const customProviders = config.custom_providers;
  if (Array.isArray(customProviders)) {
    for (const raw of customProviders) {
      if (!isRecord(raw)) {
        continue;
      }
      const id = readString(raw.name) ?? readString(raw.id);
      if (!id) {
        continue;
      }
      const resolvedBaseUrl = readProviderBaseUrl(raw, env);
      const baseUrl = resolvedBaseUrl.baseUrl;
      const api = resolveProviderApi(baseUrl ? { ...raw, base_url: baseUrl } : raw, id);
      if (!baseUrl || !api) {
        continue;
      }
      const headerConfig = readProviderHeaders(raw, env, includeSecrets);
      upsert(
        {
          id: resolveHermesConfiguredProviderId(config, id, env),
          baseUrl,
          api,
          apiKeyEnv: readProviderApiKeyEnv(raw) ?? resolveHermesEndpointApiKeyEnv(baseUrl),
          headers: headerConfig.headers,
          models: collectProviderModels(raw),
          sensitive: resolvedBaseUrl.sensitive || headerConfig.sensitive,
        },
        { fallbackOnly: true },
      );
    }
  }

  const model = config.model;
  if (isRecord(model)) {
    const rawProvider = readString(model.provider);
    const resolvedBaseUrl = readProviderBaseUrl(model, env);
    const envBaseUrl = resolveHermesProviderBaseUrlEnv(rawProvider, env);
    const baseUrl =
      resolvedBaseUrl.baseUrl ?? envBaseUrl ?? resolveHermesImplicitBaseUrl(rawProvider);
    const api = resolveProviderApi(baseUrl ? { ...model, base_url: baseUrl } : model, rawProvider);
    if (baseUrl && api) {
      const headerConfig = readProviderHeaders(model, env, includeSecrets);
      upsert({
        id: rawProvider ? resolveHermesConfiguredProviderId(config, rawProvider, env) : "custom",
        baseUrl,
        api,
        apiKeyEnv:
          readProviderApiKeyEnv(model) ??
          resolveHermesProviderApiKeyEnv(rawProvider) ??
          resolveHermesEndpointApiKeyEnv(baseUrl),
        headers: headerConfig.headers,
        models: collectProviderModels(model),
        sensitive: resolvedBaseUrl.sensitive || Boolean(envBaseUrl) || headerConfig.sensitive,
      });
    }
  } else {
    const rawProvider = readString(config.provider);
    const baseUrl =
      resolveHermesProviderBaseUrlEnv(rawProvider, env) ??
      resolveHermesImplicitBaseUrl(rawProvider);
    const api = resolveProviderApi(baseUrl ? { base_url: baseUrl } : {}, rawProvider);
    if (rawProvider && baseUrl && api) {
      upsert({
        id: resolveHermesConfiguredProviderId(config, rawProvider, env),
        baseUrl,
        api,
        apiKeyEnv:
          resolveHermesProviderApiKeyEnv(rawProvider) ?? resolveHermesEndpointApiKeyEnv(baseUrl),
        models: [],
        sensitive: true,
      });
    }
  }
  return collected;
}

export function collectHermesProviderSecretBindings(
  config: Record<string, unknown>,
  env: Record<string, string> = {},
): HermesProviderSecretBinding[] {
  const bindings = collectHermesProviders(config, env).flatMap((entry) =>
    entry.apiKeyEnv ? [{ envVar: entry.apiKeyEnv, provider: entry.id }] : [],
  );
  for (const [sourceProvider, raw] of Object.entries(childRecord(config, "providers"))) {
    if (!isRecord(raw)) {
      continue;
    }
    const envVar = readProviderApiKeyEnv(raw) ?? resolveHermesProviderApiKeyEnv(sourceProvider);
    if (envVar) {
      bindings.push({
        envVar,
        provider: resolveHermesConfiguredProviderId(config, sourceProvider, env),
      });
    }
  }
  if (Array.isArray(config.custom_providers)) {
    for (const raw of config.custom_providers) {
      if (!isRecord(raw)) {
        continue;
      }
      const sourceProvider = readString(raw.name) ?? readString(raw.id);
      const envVar = readProviderApiKeyEnv(raw);
      if (sourceProvider && envVar) {
        bindings.push({
          envVar,
          provider: resolveHermesConfiguredProviderId(config, sourceProvider, env),
        });
      }
    }
  }
  const model = isRecord(config.model) ? config.model : undefined;
  const selectedProvider = readString(model?.provider) ?? readString(config.provider);
  const selectedEnv =
    (model ? readProviderApiKeyEnv(model) : undefined) ??
    resolveHermesProviderApiKeyEnv(selectedProvider);
  if (selectedProvider && selectedEnv) {
    bindings.push({
      envVar: selectedEnv,
      provider: resolveHermesConfiguredProviderId(config, selectedProvider, env),
    });
  }
  return [
    ...new Map(
      bindings.map((binding) => [`${binding.provider}\0${binding.envVar}`, binding]),
    ).values(),
  ];
}

function addSelectedModelToProvider(
  providers: HermesProviderConfig[],
  modelRef: string | undefined,
): void {
  if (!modelRef) {
    return;
  }
  const slash = modelRef.indexOf("/");
  if (slash <= 0 || slash === modelRef.length - 1) {
    return;
  }
  const provider = providers.find((entry) => entry.id === modelRef.slice(0, slash));
  const modelId = modelRef.slice(slash + 1);
  if (provider && !provider.models.some((model) => model.id === modelId)) {
    provider.models.push({ id: modelId });
  }
}

function providerManualItems(
  config: Record<string, unknown>,
  env: Record<string, string>,
  includeSecrets: boolean,
): MigrationItem[] {
  const entries: HermesProviderSource[] = [];
  const currentProviderIds = new Set(
    Object.keys(childRecord(config, "providers")).map(normalizeHermesCustomProviderId),
  );
  for (const [id, raw] of Object.entries(childRecord(config, "providers"))) {
    if (isRecord(raw)) {
      entries.push({ id, raw, source: `config.yaml:providers.${id}` });
    }
  }
  if (Array.isArray(config.custom_providers)) {
    for (const raw of config.custom_providers) {
      if (!isRecord(raw)) {
        continue;
      }
      const id = readString(raw.name) ?? readString(raw.id);
      if (id && !currentProviderIds.has(normalizeHermesCustomProviderId(id))) {
        entries.push({ id, raw, source: `config.yaml:custom_providers.${id}` });
      }
    }
  }
  if (isRecord(config.model)) {
    const provider = readString(config.model.provider);
    const baseUrl = readString(config.model.base_url) ?? readString(config.model.baseUrl);
    if (baseUrl) {
      entries.push({
        id: provider
          ? resolveHermesConfiguredProviderId(config, provider, env) || "custom"
          : "custom",
        raw: config.model,
        source: "config.yaml:model",
      });
    }
  }
  const items: MigrationItem[] = [];
  for (const { id, raw, source } of entries) {
    const transport = readString(raw.transport) ?? readString(raw.api_mode);
    const baseUrlConfig = readProviderBaseUrl(raw, env);
    const baseUrl = baseUrlConfig.baseUrl ?? resolveHermesImplicitBaseUrl(id);
    const headerConfig = readProviderHeaders(raw, env, includeSecrets);
    if (transport && !HERMES_TRANSPORTS[transport]) {
      items.push(
        createMigrationManualItem({
          id: `manual:model-provider-transport:${sanitizeName(id)}`,
          source: `${source}.transport`,
          message: `Hermes provider "${id}" uses unsupported transport "${transport}".`,
          recommendation:
            "Configure an equivalent OpenClaw provider plugin or API adapter manually.",
        }),
      );
    } else if (baseUrlConfig.unresolved) {
      items.push(
        createMigrationManualItem({
          id: `manual:model-provider-endpoint-env:${sanitizeName(id)}`,
          source,
          message: `Hermes provider "${id}" references an endpoint environment variable that was not present in the Hermes .env file.`,
          recommendation: "Configure the provider endpoint manually after migration.",
        }),
      );
    } else if (!baseUrl) {
      items.push(
        createMigrationManualItem({
          id: `manual:model-provider-endpoint:${sanitizeName(id)}`,
          source,
          message: `Hermes provider "${id}" has no explicit endpoint to import safely.`,
          recommendation: "Configure the provider endpoint manually after migration.",
        }),
      );
    }
    if (readString(raw.api_key) && !readEnvReference(raw.api_key)) {
      items.push(
        createMigrationManualItem({
          id: `manual:model-provider-inline-key:${sanitizeName(id)}`,
          source: `${source}.api_key`,
          message: `Hermes provider "${id}" contains an inline API key that was not copied into OpenClaw config.`,
          recommendation: "Move the key to an environment variable or OpenClaw secret provider.",
        }),
      );
    }
    if (headerConfig.blocked) {
      items.push(
        createMigrationManualItem({
          id: `manual:model-provider-headers:${sanitizeName(id)}`,
          source: `${source}.extra_headers`,
          message: `Hermes provider "${id}" has literal request headers that require secret migration consent.`,
          recommendation: "Rerun with --include-secrets or configure the headers manually.",
        }),
      );
    } else if (headerConfig.unresolved) {
      items.push(
        createMigrationManualItem({
          id: `manual:model-provider-headers-env:${sanitizeName(id)}`,
          source: `${source}.extra_headers`,
          message: `Hermes provider "${id}" has request header environment references that could not be resolved.`,
          recommendation: "Configure the provider headers manually after migration.",
        }),
      );
    }
    if (headerConfig.invalid) {
      items.push(
        createMigrationManualItem({
          id: `manual:model-provider-headers-invalid:${sanitizeName(id)}`,
          source: `${source}.extra_headers`,
          message: `Hermes provider "${id}" has non-scalar request header values that were not imported.`,
          recommendation: "Configure valid string header values manually after migration.",
        }),
      );
    }
    if (isRecord(raw.extra_body) && Object.keys(raw.extra_body).length > 0) {
      items.push(
        createMigrationManualItem({
          id: `manual:model-provider-extra-body:${sanitizeName(id)}`,
          source: `${source}.extra_body`,
          message: `Hermes provider "${id}" adds request body fields that OpenClaw cannot import generically.`,
          recommendation:
            "Configure an equivalent provider plugin or supported request option manually.",
        }),
      );
    }
    const apiKeyEnv = readProviderApiKeyEnv(raw);
    if (apiKeyEnv && !env[apiKeyEnv]?.trim()) {
      items.push(
        createMigrationManualItem({
          id: `manual:model-provider-key-env:${sanitizeName(id)}`,
          source: `${source}.key_env`,
          message: `Hermes provider "${id}" references ${apiKeyEnv}, but that value was not present in the Hermes .env file.`,
          recommendation:
            "Configure an OpenClaw auth profile for this provider or expose the variable to the OpenClaw runtime.",
        }),
      );
    }
  }
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

const MCP_RESOURCE_UTILITY_TOOLS = ["resources_list", "resources_read"] as const;
const MCP_PROMPT_UTILITY_TOOLS = ["prompts_list", "prompts_get"] as const;

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readBooleanish(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) {
    return true;
  }
  return ["false", "0", "no", "off"].includes(normalized) ? false : undefined;
}

function readPositiveNumeric(value: unknown): number | undefined {
  if (typeof value === "number") {
    return readPositiveNumber(value);
  }
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  return readPositiveNumber(Number(value));
}

function readToolFilterList(value: unknown): string[] | undefined {
  if (typeof value === "string") {
    return value.trim() ? [value.trim()] : undefined;
  }
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    return undefined;
  }
  const normalized = [...new Set(value.map((entry) => entry.trim()).filter(Boolean))];
  return normalized;
}

function mapHermesToolFilter(value: Record<string, unknown>): Record<string, unknown> | undefined {
  const direct = isRecord(value.toolFilter)
    ? value.toolFilter
    : isRecord(value.tool_filter)
      ? value.tool_filter
      : undefined;
  if (direct) {
    const include = readToolFilterList(direct.include);
    const exclude = readToolFilterList(direct.exclude);
    if (include && include.length > 0) {
      return { include };
    }
    return exclude !== undefined && exclude.length > 0 ? { exclude } : undefined;
  }

  const tools = isRecord(value.tools) ? value.tools : undefined;
  if (!tools) {
    return undefined;
  }
  const include = readToolFilterList(tools.include);
  const exclude = readToolFilterList(tools.exclude);
  const resourcesEnabled = readBooleanish(tools.resources) !== false;
  const promptsEnabled = readBooleanish(tools.prompts) !== false;

  // Hermes tests set truthiness here: `include: []` means no whitelist, so native tools remain.
  if (include && include.length > 0) {
    return {
      include: [
        ...include,
        ...(resourcesEnabled ? MCP_RESOURCE_UTILITY_TOOLS : []),
        ...(promptsEnabled ? MCP_PROMPT_UTILITY_TOOLS : []),
      ],
    };
  }
  const translatedExclude = [
    ...(exclude ?? []),
    ...(!resourcesEnabled ? MCP_RESOURCE_UTILITY_TOOLS : []),
    ...(!promptsEnabled ? MCP_PROMPT_UTILITY_TOOLS : []),
  ];
  return translatedExclude.length > 0 ? { exclude: translatedExclude } : undefined;
}

const MCP_ENV_REFERENCE_RE = /\$\{([^}]+)\}/gu;

function resolveMcpEnvReferences(
  value: unknown,
  env: Record<string, string>,
): { unresolved: boolean; value: unknown } {
  if (typeof value === "string") {
    let unresolved = false;
    const resolved = value.replace(MCP_ENV_REFERENCE_RE, (match, rawName: string) => {
      const name = normalizeHermesEnvReferenceName(rawName);
      if (!name) {
        unresolved = true;
        return match;
      }
      const replacement = env[name];
      if (replacement === undefined) {
        unresolved = true;
        return match;
      }
      return replacement;
    });
    return { unresolved, value: resolved };
  }
  if (Array.isArray(value)) {
    const entries = value.map((entry) => resolveMcpEnvReferences(entry, env));
    return {
      unresolved: entries.some((entry) => entry.unresolved),
      value: entries.map((entry) => entry.value),
    };
  }
  if (isRecord(value)) {
    const entries = Object.entries(value).map(
      ([key, entry]) => [key, resolveMcpEnvReferences(entry, env)] as const,
    );
    return {
      unresolved: entries.some(([, entry]) => entry.unresolved),
      value: Object.fromEntries(entries.map(([key, entry]) => [key, entry.value])),
    };
  }
  return { unresolved: false, value };
}

function mapHermesClientCertificate(value: Record<string, unknown>): {
  clientCert?: string;
  clientKey?: string;
} {
  const cert = value.clientCert ?? value.client_cert;
  const key = readString(value.clientKey) ?? readString(value.client_key);
  if (Array.isArray(cert) && cert.length === 2) {
    const certPath = readString(cert[0]);
    const keyPath = readString(cert[1]);
    return certPath && keyPath ? { clientCert: certPath, clientKey: keyPath } : {};
  }
  const certPath = readString(cert);
  return certPath && key ? { clientCert: certPath, clientKey: key } : {};
}

const MCP_CONNECTION_FIELDS = [
  "enabled",
  "command",
  "args",
  "cwd",
  "workingDirectory",
  "url",
  "connectionTimeoutMs",
  "requestTimeoutMs",
  "timeout",
] as const;

function mcpValueHasEnvReferences(value: unknown): boolean {
  return value !== undefined && resolveMcpEnvReferences(value, {}).unresolved;
}

function importsMcpSensitiveValues(
  value: Record<string, unknown>,
  includeSecrets: boolean,
): boolean {
  return (
    includeSecrets &&
    (value.env !== undefined ||
      value.headers !== undefined ||
      MCP_CONNECTION_FIELDS.some((key) => mcpValueHasEnvReferences(value[key])))
  );
}

function mapHermesMcpOauth(value: Record<string, unknown>): Record<string, unknown> | undefined {
  const oauth = isRecord(value.oauth) ? value.oauth : undefined;
  if (!oauth) {
    return undefined;
  }
  const mapped: Record<string, unknown> = {};
  for (const key of ["authProfileId", "scope", "redirectUrl", "clientMetadataUrl"]) {
    const fieldValue = readString(oauth[key]);
    if (fieldValue) {
      mapped[key] = fieldValue;
    }
  }
  return Object.keys(mapped).length > 0 ? mapped : undefined;
}

function mapMcpServer(
  value: Record<string, unknown>,
  includeSecrets: boolean,
  env: Record<string, string>,
): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const key of MCP_CONNECTION_FIELDS) {
    const sourceValue = value[key];
    if (sourceValue === undefined) {
      continue;
    }
    if (!mcpValueHasEnvReferences(sourceValue)) {
      next[key] = sourceValue;
      continue;
    }
    if (includeSecrets) {
      const resolved = resolveMcpEnvReferences(sourceValue, env);
      if (!resolved.unresolved) {
        next[key] = resolved.value;
      }
    }
  }
  const transport = readString(value.transport) ?? readString(value.type);
  if (transport === "http" || transport === "streamable-http") {
    next.transport = "streamable-http";
  } else if (transport === "sse" || transport === "stdio") {
    next.transport = transport;
  } else if (!transport && readString(next.url)) {
    next.transport = "streamable-http";
  }
  next.connectTimeout = value.connectTimeout ?? value.connect_timeout;
  next.supportsParallelToolCalls = readBoolean(
    value.supportsParallelToolCalls ?? value.supports_parallel_tool_calls,
  );
  next.sslVerify = readBoolean(value.sslVerify ?? value.ssl_verify);
  next.auth = readString(value.auth) === "oauth" ? "oauth" : undefined;
  next.oauth = mapHermesMcpOauth(value);
  Object.assign(next, mapHermesClientCertificate(value));
  const toolFilter = mapHermesToolFilter(value);
  next.toolFilter = toolFilter;
  if (includeSecrets) {
    for (const key of ["env", "headers"]) {
      if (value[key] !== undefined) {
        const resolved = resolveMcpEnvReferences(value[key], env);
        if (!resolved.unresolved) {
          next[key] = resolved.value;
        }
      }
    }
  }
  const mapped = Object.fromEntries(
    Object.entries(next).filter(([, entry]) => entry !== undefined),
  );
  return readString(mapped.command) || readString(mapped.url) ? mapped : {};
}

function mcpManualItems(params: {
  name: string;
  raw: Record<string, unknown>;
  includeSecrets: boolean;
  env: Record<string, string>;
  source: string;
}): MigrationItem[] {
  const { name, raw } = params;
  const safeName = sanitizeName(name);
  const items: MigrationItem[] = [];
  const add = (suffix: string, message: string, recommendation: string): void => {
    items.push(
      createMigrationManualItem({
        id: `manual:mcp-server-${suffix}:${safeName}`,
        source: params.source,
        message,
        recommendation,
      }),
    );
  };

  const interpolatedValues = [
    ...MCP_CONNECTION_FIELDS.map((key) => raw[key]),
    raw.env,
    raw.headers,
  ];
  if (
    !params.includeSecrets &&
    (raw.env !== undefined ||
      raw.headers !== undefined ||
      interpolatedValues.some(mcpValueHasEnvReferences))
  ) {
    add(
      "secrets",
      `Hermes MCP server "${name}" has environment-backed values that were not imported without secret consent.`,
      "Re-run with --include-secrets or configure these values manually.",
    );
  }
  if (
    params.includeSecrets &&
    interpolatedValues.some(
      (value) => value !== undefined && resolveMcpEnvReferences(value, params.env).unresolved,
    )
  ) {
    add(
      "unresolved-secrets",
      `Hermes MCP server "${name}" references environment values that were not found in its .env file.`,
      "Define the missing values in OpenClaw's MCP server environment or headers manually.",
    );
  }

  const cert = raw.clientCert ?? raw.client_cert;
  const key = readString(raw.clientKey) ?? readString(raw.client_key);
  if (Array.isArray(cert) && cert.length === 3) {
    add(
      "client-cert-password",
      `Hermes MCP server "${name}" uses a password-protected client key, which OpenClaw cannot represent in MCP config.`,
      "Configure an unencrypted protected key path or an equivalent TLS proxy manually.",
    );
  } else if (
    (cert !== undefined || key !== undefined) &&
    !(
      (Array.isArray(cert) && cert.length === 2 && readString(cert[0]) && readString(cert[1])) ||
      (readString(cert) && key)
    )
  ) {
    add(
      "client-cert",
      `Hermes MCP server "${name}" uses a combined or invalid client-certificate shape that was not imported.`,
      "Configure separate OpenClaw clientCert and clientKey file paths manually.",
    );
  }
  if (typeof (raw.sslVerify ?? raw.ssl_verify) === "string") {
    add(
      "tls-ca",
      `Hermes MCP server "${name}" uses a CA bundle path for TLS verification, which OpenClaw MCP config cannot represent.`,
      "Install the CA in the host trust store or configure an equivalent TLS proxy manually.",
    );
  }

  const transport = readString(raw.transport) ?? readString(raw.type);
  if (transport && !["http", "streamable-http", "sse", "stdio"].includes(transport)) {
    add(
      "transport",
      `Hermes MCP server "${name}" uses unsupported transport "${transport}".`,
      "Configure an equivalent OpenClaw MCP transport manually.",
    );
  }

  const auth = readString(raw.auth);
  if (auth && auth !== "oauth") {
    add(
      "auth",
      `Hermes MCP server "${name}" uses unsupported authentication mode "${auth}".`,
      "Configure an equivalent OpenClaw MCP authentication mode manually.",
    );
  }
  const oauth = isRecord(raw.oauth) ? raw.oauth : undefined;
  if (auth === "oauth" || oauth) {
    add(
      "oauth-login",
      `Hermes MCP server "${name}" requires OAuth login in OpenClaw.`,
      `Run "openclaw mcp login ${name}" after migration.`,
    );
  }
  if (
    oauth &&
    Object.keys(oauth).some(
      (keyName) =>
        !["authProfileId", "scope", "redirectUrl", "clientMetadataUrl"].includes(keyName),
    )
  ) {
    add(
      "oauth-client",
      `Hermes MCP server "${name}" uses pre-registered OAuth client settings that were not copied into OpenClaw config.`,
      `Run "openclaw mcp login ${name}" and configure supported OAuth metadata manually.`,
    );
  }

  const tools = isRecord(raw.tools) ? raw.tools : undefined;
  if (
    tools &&
    (Object.keys(tools).some(
      (keyName) => !["include", "exclude", "resources", "prompts"].includes(keyName),
    ) ||
      (tools.include !== undefined && !readToolFilterList(tools.include)) ||
      (tools.exclude !== undefined && !readToolFilterList(tools.exclude)) ||
      (tools.resources !== undefined && readBooleanish(tools.resources) === undefined) ||
      (tools.prompts !== undefined && readBooleanish(tools.prompts) === undefined))
  ) {
    add(
      "tool-policy",
      `Hermes MCP server "${name}" has a tool policy that cannot be translated exactly.`,
      "Review and configure mcp.servers toolFilter manually.",
    );
  }

  const lifecycle = isRecord(raw.lifecycle) ? raw.lifecycle : {};
  const unsupported = [
    ["preflight", raw.skip_preflight === true],
    ["sampling", isRecord(raw.sampling) && raw.sampling.enabled !== false],
    ["elicitation", isRecord(raw.elicitation) && raw.elicitation.enabled !== false],
    [
      "lifecycle",
      readPositiveNumeric(raw.idle_timeout_seconds ?? lifecycle.idle_timeout_seconds) !==
        undefined ||
        readPositiveNumeric(raw.max_lifetime_seconds ?? lifecycle.max_lifetime_seconds) !==
          undefined,
    ],
    ["keepalive", readPositiveNumeric(raw.keepalive_interval) !== undefined],
  ] as const;
  for (const [feature, configured] of unsupported) {
    if (configured) {
      add(
        feature,
        `Hermes MCP server "${name}" uses ${feature} behavior that OpenClaw MCP config does not expose.`,
        "Review the server requirement and configure an equivalent deployment or runtime policy manually.",
      );
    }
  }
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function mapSkillEntries(config: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries: Record<string, unknown> = {};
  for (const [skillKey, value] of Object.entries(
    childRecord(childRecord(config, "skills"), "config"),
  )) {
    if (isRecord(value)) {
      entries[skillKey] = { config: value };
    }
  }
  return Object.keys(entries).length > 0 ? entries : undefined;
}

export function buildConfigItems(params: {
  ctx: MigrationProviderContext;
  config: Record<string, unknown>;
  env?: Record<string, string>;
  runtimeEnv?: Record<string, string>;
  modelRef?: string;
  hasMemoryFiles?: boolean;
}): MigrationItem[] {
  const items: MigrationItem[] = [];
  const memory = childRecord(params.config, "memory");
  const memoryProvider = readString(memory.provider);

  if (params.hasMemoryFiles || memoryProvider) {
    items.push(
      createMigrationConfigPatchItem({
        id: "config:memory",
        target: "memory",
        path: ["memory"],
        value: { backend: "builtin" },
        message: "Use OpenClaw built-in file memory for imported Hermes memory files.",
        conflict:
          !params.ctx.overwrite &&
          hasMigrationConfigPatchConflict(params.ctx.config, ["memory"], { backend: true }),
      }),
    );
    items.push(
      createMigrationConfigPatchItem({
        id: "config:memory-plugin-slot",
        target: "plugins.slots",
        path: ["plugins", "slots"],
        value: { memory: "memory-core" },
        message: "Select the default OpenClaw memory plugin for imported file memory.",
        conflict:
          !params.ctx.overwrite &&
          hasMigrationConfigPatchConflict(params.ctx.config, ["plugins", "slots"], {
            memory: true,
          }),
      }),
    );
  }

  if (memoryProvider === "honcho") {
    const value = {
      honcho: {
        enabled: true,
        config: childRecord(memory, "honcho"),
      },
    };
    items.push(
      createMigrationConfigPatchItem({
        id: "config:memory-plugin:honcho",
        target: "plugins.entries.honcho",
        path: ["plugins", "entries"],
        value,
        message: "Preserve Hermes Honcho memory settings as a plugin entry for manual activation.",
        conflict:
          !params.ctx.overwrite &&
          hasMigrationConfigPatchConflict(params.ctx.config, ["plugins", "entries"], value),
      }),
    );
    items.push(
      createMigrationManualItem({
        id: "manual:memory-provider:honcho",
        source: "config.yaml:memory.provider",
        message:
          "Hermes used Honcho memory. OpenClaw keeps built-in memory selected until the matching plugin is installed and reviewed.",
        recommendation:
          "Install or review the Honcho memory plugin before selecting it for plugins.slots.memory.",
      }),
    );
  } else if (memoryProvider && !["builtin", "file", "files"].includes(memoryProvider)) {
    items.push(
      createMigrationManualItem({
        id: `manual:memory-provider:${memoryProvider}`,
        source: "config.yaml:memory.provider",
        message: `Hermes memory provider "${memoryProvider}" does not have a known OpenClaw mapping.`,
        recommendation: "Install or configure an equivalent OpenClaw memory plugin manually.",
      }),
    );
  }

  const providers = collectHermesProviders(
    params.config,
    params.env,
    Boolean(params.ctx.includeSecrets),
  );
  addSelectedModelToProvider(providers, params.modelRef);
  for (const provider of providers) {
    const value = { [provider.id]: providerConfig(provider) };
    items.push(
      createMigrationConfigPatchItem({
        id: `config:model-provider:${sanitizeName(provider.id)}`,
        target: `models.providers.${provider.id}`,
        path: ["models", "providers"],
        value,
        message: `Import Hermes provider and custom endpoint config for "${provider.id}".`,
        sensitive: provider.sensitive,
        conflict:
          !params.ctx.overwrite &&
          hasMigrationConfigPatchConflict(params.ctx.config, ["models", "providers"], value),
      }),
    );
  }
  items.push(
    ...providerManualItems(params.config, params.env ?? {}, Boolean(params.ctx.includeSecrets)),
  );

  const mcpConfig = params.config.mcp;
  const rawMcpServers =
    params.config.mcp_servers ??
    (isRecord(mcpConfig) && isRecord(mcpConfig.servers) ? mcpConfig.servers : mcpConfig);
  const rawMcpSource =
    params.config.mcp_servers !== undefined
      ? "config.yaml:mcp_servers"
      : isRecord(mcpConfig) && isRecord(mcpConfig.servers)
        ? "config.yaml:mcp.servers"
        : "config.yaml:mcp";
  if (isRecord(rawMcpServers)) {
    // Hermes loads process env first, then lets its source .env override those values.
    const mcpEnv = { ...params.runtimeEnv, ...params.env };
    for (const [name, rawServer] of Object.entries(rawMcpServers)) {
      if (!isRecord(rawServer)) {
        continue;
      }
      const server = mapMcpServer(rawServer, Boolean(params.ctx.includeSecrets), mcpEnv);
      if (Object.keys(server).length > 0) {
        const value = { [name]: server };
        items.push(
          createMigrationConfigPatchItem({
            id: `config:mcp-server:${sanitizeName(name)}`,
            target: `mcp.servers.${name}`,
            path: ["mcp", "servers"],
            value,
            message: `Import Hermes MCP server definition "${name}".`,
            sensitive: importsMcpSensitiveValues(rawServer, Boolean(params.ctx.includeSecrets)),
            conflict:
              !params.ctx.overwrite &&
              hasMigrationConfigPatchConflict(params.ctx.config, ["mcp", "servers"], value),
          }),
        );
      }
      items.push(
        ...mcpManualItems({
          name,
          raw: rawServer,
          includeSecrets: Boolean(params.ctx.includeSecrets),
          env: mcpEnv,
          source: `${rawMcpSource}.${name}`,
        }),
      );
    }
  }

  const skillEntries = mapSkillEntries(params.config);
  if (skillEntries) {
    items.push(
      createMigrationConfigPatchItem({
        id: "config:skill-entries",
        target: "skills.entries",
        path: ["skills", "entries"],
        value: skillEntries,
        message: "Import Hermes skill config values.",
        conflict:
          !params.ctx.overwrite &&
          hasMigrationConfigPatchConflict(params.ctx.config, ["skills", "entries"], skillEntries),
      }),
    );
  }

  return items;
}

export async function applyConfigItem(
  ctx: MigrationProviderContext,
  item: MigrationItem,
): Promise<MigrationItem> {
  return applyMigrationConfigPatchItem(ctx, item);
}

export function applyManualItem(item: MigrationItem): MigrationItem {
  return applyMigrationManualItem(item);
}
