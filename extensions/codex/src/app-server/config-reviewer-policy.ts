import { readFileSync } from "node:fs";
import path from "node:path";
import type { resolveProviderIdForAuth } from "openclaw/plugin-sdk/agent-runtime";
import { parse as parseToml, type TomlTable } from "smol-toml";
import {
  resolveCodexAppServerHomeDir,
  resolveCodexAppServerUserHomeDir,
} from "./auth-start-options.js";
import type {
  CodexAppServerHomeScope,
  CodexModelBackedReviewerContext,
  ProviderAuthAliasConfig,
} from "./config-contracts.js";
import { readCodexEffectiveConfig, type CodexConfigReadClient } from "./config-layer-policy.js";
import { readNonEmptyString, readRecord } from "./config-utils.js";
import { readCodexAppServerConfigOptions } from "./launch-args.js";
import type { CodexConfigReadResponse } from "./protocol-control-plane.js";

const CODEX_CONFIG_TOML_FILENAME = "config.toml";
// Rust's CLI trim uses Unicode White_Space, which includes U+0085 unlike String.trim().
const CODEX_CLI_WHITESPACE = /^\p{White_Space}+|\p{White_Space}+$/gu;

/** Cloud/system config can redirect reviews after local home/profile checks have passed. */
export async function assertCodexModelBackedReviewerEffectiveConfig(params: {
  client: CodexConfigReadClient;
  approvalsReviewer: string;
  cwd: string;
  signal?: AbortSignal;
}): Promise<CodexConfigReadResponse | undefined> {
  if (
    params.approvalsReviewer !== "auto_review" &&
    params.approvalsReviewer !== "guardian_subagent"
  ) {
    return undefined;
  }
  const response = await readCodexEffectiveConfig(params.client, params.cwd, {
    signal: params.signal,
  });
  if (!isTrustedCodexReviewerConfig(response.config)) {
    throw new Error(
      "Codex model-backed approval reviewer requires the running server to use a trusted OpenAI endpoint",
    );
  }
  return response;
}

function isTrustedCodexReviewerConfig(config: Record<string, unknown>): boolean {
  const modelProvider = config.model_provider;
  const providers = config.model_providers;
  const providerRecords = providers == null ? undefined : readRecord(providers);
  const provider = providerRecords?.openai;
  const openAIProvider = provider == null ? undefined : readRecord(provider);
  return (
    (modelProvider == null || modelProvider === "openai") &&
    (providers == null || providerRecords !== undefined) &&
    (provider == null || openAIProvider !== undefined) &&
    isTrustedOptionalReviewerEndpoint(config.openai_base_url, isNativeOpenAIBaseUrl) &&
    isTrustedOptionalReviewerEndpoint(config.chatgpt_base_url, isNativeChatGPTBaseUrl) &&
    isTrustedOptionalReviewerEndpoint(openAIProvider?.base_url, isNativeOpenAIBaseUrl)
  );
}

function isTrustedOptionalReviewerEndpoint(
  value: unknown,
  isTrusted: (value: unknown) => boolean,
): boolean {
  return value == null || (typeof value === "string" && isTrusted(value));
}

export function canUseCodexModelBackedApprovalsReviewerForModel(
  params: CodexModelBackedReviewerContext,
  resolveAuthProviderId: typeof resolveProviderIdForAuth,
): boolean {
  const explicitProvider = params.modelProvider?.trim().toLowerCase();
  const inferredProvider = inferProviderFromModelRef(params.model);
  if (explicitProvider && explicitProvider !== "codex" && explicitProvider !== "openai") {
    return false;
  }
  return (
    (inferredProvider ?? explicitProvider) === "openai" &&
    isTrustedCodexModelBackedOpenAIProvider(params, resolveAuthProviderId)
  );
}

function isTrustedCodexModelBackedOpenAIProvider(
  params: {
    config?: ProviderAuthAliasConfig;
    env?: NodeJS.ProcessEnv;
    model?: string;
    agentDir?: string;
    codexConfigToml?: string | null;
    homeScope?: CodexAppServerHomeScope;
    codexArgs?: readonly string[];
  },
  resolveAuthProviderId: typeof resolveProviderIdForAuth,
): boolean {
  if (![params.env?.OPENAI_BASE_URL, params.env?.OPENAI_API_BASE].every(isNativeOpenAIBaseUrl)) {
    return false;
  }
  if (!nativeCodexConfigIsTrustedForModelBackedReview(params)) {
    return false;
  }
  const openAIProviders = readConfiguredOpenAIProvidersForModelBackedReview(
    params.config,
    resolveAuthProviderId,
  );
  return openAIProviders.every((openAIProvider) =>
    configuredOpenAIProviderIsTrustedForModelBackedReview(openAIProvider, params.model),
  );
}

export function resolveCodexModelBackedReviewerPolicyContext(params: {
  provider?: string;
  model?: string;
  bindingModelProvider?: string;
  bindingModel?: string;
  nativeAuthProfile?: boolean;
}): CodexModelBackedReviewerContext {
  const provider = params.provider?.trim();
  if (provider && provider.toLowerCase() !== "codex") {
    return {
      modelProvider: normalizeCodexModelBackedReviewerPolicyProvider(provider),
      model: params.model,
    };
  }
  const bindingModelProvider = params.bindingModelProvider?.trim();
  const currentModel = params.model?.trim();
  const bindingModel = params.bindingModel?.trim();
  const modelProvider =
    bindingModelProvider && currentModel && bindingModel && currentModel === bindingModel
      ? bindingModelProvider
      : (inferProviderFromModelRef(params.model) ?? bindingModelProvider) ||
        (params.nativeAuthProfile === true ? "openai" : undefined);
  return {
    modelProvider: modelProvider
      ? normalizeCodexModelBackedReviewerPolicyProvider(modelProvider)
      : undefined,
    model: params.model ?? params.bindingModel,
  };
}

function nativeCodexConfigIsTrustedForModelBackedReview(
  params: Pick<
    CodexModelBackedReviewerContext,
    "agentDir" | "codexArgs" | "codexConfigToml" | "env" | "homeScope"
  >,
): boolean {
  const configToml = readCodexAppServerConfigToml(params);
  if (configToml === false) {
    return false;
  }
  const nativeOverrides = readNativeCodexReviewerConfigOverrides(params);
  if (nativeOverrides === false) {
    return false;
  }
  if (configToml !== undefined) {
    try {
      nativeOverrides.unshift(parseToml(configToml, { integersAsBigInt: true }));
    } catch {
      return false;
    }
  }
  return nativeOverrides.every(isTrustedCodexReviewerConfig);
}

function readNativeCodexReviewerConfigOverrides(
  params: Pick<CodexModelBackedReviewerContext, "agentDir" | "codexArgs" | "env" | "homeScope">,
): Record<string, unknown>[] | false {
  if (params.codexArgs?.some((arg) => !arg)) {
    return false;
  }
  const overrides: Record<string, unknown>[] = [];
  let profile: string | undefined;
  for (const { name, value } of readCodexAppServerConfigOptions(params.codexArgs ?? [])) {
    if (!value) {
      return false;
    }
    if (name === "--profile" || name === "-p") {
      profile = value;
    } else {
      const override = parseNativeCodexReviewerConfigOverride(value);
      if (override === false) {
        return false;
      }
      overrides.push(override);
    }
  }
  if (profile) {
    if (path.basename(profile) !== profile || profile === "." || profile === "..") {
      return false;
    }
    const configPath = resolveCodexAppServerConfigPath(params);
    if (!configPath) {
      return false;
    }
    try {
      overrides.unshift(
        parseToml(
          readFileSync(path.join(path.dirname(configPath), `${profile}.config.toml`), "utf8"),
          { integersAsBigInt: true },
        ),
      );
    } catch (error) {
      if (readErrorCode(error) !== "ENOENT") {
        return false;
      }
    }
  }
  return overrides;
}

function parseNativeCodexReviewerConfigOverride(override: string): Record<string, unknown> | false {
  const separator = override.indexOf("=");
  if (separator < 0) {
    return false;
  }
  const key = override.slice(0, separator).replace(CODEX_CLI_WHITESPACE, "");
  if (!key) {
    return false;
  }
  const raw = override.slice(separator + 1).replace(CODEX_CLI_WHITESPACE, "");
  let value: unknown;
  try {
    value = parseToml(`_x_ = ${raw}`, { integersAsBigInt: true })["_x_"];
  } catch {
    // Codex CLI treats non-TOML values as raw strings, including unmatched outer quotes.
    value = raw.replace(/^["']+|["']+$/g, "");
  }
  for (const segment of key.split(".").toReversed()) {
    value = { [segment]: value };
  }
  return readRecord(value) ?? false;
}

function readCodexAppServerConfigToml(
  params: Pick<
    CodexModelBackedReviewerContext,
    "agentDir" | "codexConfigToml" | "env" | "homeScope"
  > & { codexHome?: string },
): string | undefined | false {
  if (params.codexConfigToml !== undefined) {
    return params.codexConfigToml ?? undefined;
  }
  const configPath = resolveCodexAppServerConfigPath(params);
  if (!configPath) {
    return undefined;
  }
  try {
    return readFileSync(configPath, "utf8");
  } catch (error) {
    return readErrorCode(error) === "ENOENT" ? undefined : false;
  }
}

export function codexConfigEnablesNativeComputerUse(
  params: Pick<
    CodexModelBackedReviewerContext,
    "agentDir" | "codexConfigToml" | "env" | "homeScope"
  > & { codexHome?: string; pluginNames: readonly string[] },
): boolean {
  const configToml = readCodexAppServerConfigToml(params);
  if (configToml === false) {
    return true;
  }
  if (configToml === undefined) {
    return false;
  }
  let parsedConfig: TomlTable;
  try {
    parsedConfig = parseToml(configToml, { integersAsBigInt: true });
  } catch {
    return true;
  }
  const rawPlugins = parsedConfig.plugins;
  if (rawPlugins === undefined) {
    return false;
  }
  const plugins = readRecord(rawPlugins);
  if (!plugins) {
    return true;
  }
  for (const [pluginId, rawPluginConfig] of Object.entries(plugins)) {
    const matchesManagedIdentity = params.pluginNames.some(
      (pluginName) => pluginId === pluginName || pluginId.startsWith(`${pluginName}@`),
    );
    if (!matchesManagedIdentity) {
      continue;
    }
    const pluginConfig = readRecord(rawPluginConfig);
    if (!pluginConfig) {
      return true;
    }
    if (pluginConfig.enabled === false) {
      continue;
    }
    // Codex defaults omitted enablement to true; malformed state stays conservative.
    return true;
  }
  return false;
}

function resolveCodexAppServerConfigPath(
  params: Pick<CodexModelBackedReviewerContext, "agentDir" | "env" | "homeScope"> & {
    codexHome?: string;
  },
): string | undefined {
  if (params.codexHome) {
    return path.join(params.codexHome, CODEX_CONFIG_TOML_FILENAME);
  }
  if (params.homeScope === "user") {
    return path.join(resolveCodexAppServerUserHomeDir(params.env), CODEX_CONFIG_TOML_FILENAME);
  }
  const agentDir = readNonEmptyString(params.agentDir);
  return agentDir
    ? path.join(resolveCodexAppServerHomeDir(agentDir), CODEX_CONFIG_TOML_FILENAME)
    : undefined;
}

function readErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
}

function readConfiguredOpenAIProvidersForModelBackedReview(
  config: ProviderAuthAliasConfig | undefined,
  resolveAuthProviderId: typeof resolveProviderIdForAuth,
): Array<Record<string, unknown>> {
  const providerRecords = readRecord(readRecord(readRecord(config)?.models)?.providers);
  if (!providerRecords) {
    return [];
  }
  const openAIProviders: Array<Record<string, unknown>> = [];
  for (const [providerId, providerConfig] of Object.entries(providerRecords)) {
    if (resolveAuthProviderId(providerId, { config }) !== "openai") {
      continue;
    }
    const record = readRecord(providerConfig);
    if (record) {
      openAIProviders.push(record);
    }
  }
  return openAIProviders;
}

function configuredOpenAIProviderIsTrustedForModelBackedReview(
  openAIProvider: Record<string, unknown>,
  modelInput: string | undefined,
): boolean {
  if (
    readRecord(openAIProvider.localService) ||
    hasNonEmptyRecord(openAIProvider.headers) ||
    hasNonEmptyRecord(openAIProvider.request) ||
    typeof openAIProvider.authHeader === "boolean" ||
    !isNativeOpenAIBaseUrl(openAIProvider.baseUrl)
  ) {
    return false;
  }
  const models = openAIProvider.models;
  if (!Array.isArray(models)) {
    return true;
  }
  const modelId = normalizeOpenAIModelBackedReviewerModelId(modelInput);
  if (!modelId) {
    return false;
  }
  for (const entry of models) {
    const model = readRecord(entry);
    if (typeof model?.id !== "string" || !matchesConfiguredOpenAIModelId(modelId, model.id)) {
      continue;
    }
    if (
      hasNonEmptyRecord(model.headers) ||
      hasNonEmptyRecord(model.request) ||
      !isNativeOpenAIBaseUrl(model.baseUrl)
    ) {
      return false;
    }
  }
  return true;
}

function normalizeOpenAIModelBackedReviewerModelId(modelInput: string | undefined): string {
  const normalized = modelInput?.trim() ?? "";
  const authProfileIndex = normalized.indexOf("@");
  const withoutAuthProfile =
    authProfileIndex > 0 ? normalized.slice(0, authProfileIndex) : normalized;
  const slashIndex = withoutAuthProfile.indexOf("/");
  return slashIndex > 0 ? withoutAuthProfile.slice(slashIndex + 1).trim() : withoutAuthProfile;
}

function matchesConfiguredOpenAIModelId(modelId: string, configuredModelId: string): boolean {
  const configured = normalizeOpenAIModelBackedReviewerModelId(configuredModelId);
  return Boolean(configured) && (modelId === configured || modelId.startsWith(`${configured}@`));
}

function hasNonEmptyRecord(value: unknown): boolean {
  const record = readRecord(value);
  return record !== undefined && Object.keys(record).length > 0;
}

function isNativeOpenAIBaseUrl(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) {
    return true;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.toLowerCase() === "api.openai.com";
  } catch {
    return false;
  }
}

function isNativeChatGPTBaseUrl(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) {
    return true;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.toLowerCase() === "chatgpt.com";
  } catch {
    return false;
  }
}

function normalizeCodexModelBackedReviewerPolicyProvider(provider: string): string {
  return provider.toLowerCase() === "openai" ? "openai" : provider;
}

function inferProviderFromModelRef(model: string | undefined): string | undefined {
  const normalized = model?.trim().toLowerCase();
  const slashIndex = normalized?.indexOf("/") ?? -1;
  return slashIndex > 0 ? normalized?.slice(0, slashIndex) : undefined;
}
