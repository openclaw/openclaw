import type { CodexAppServerConnectionClass } from "./config-contracts.js";
import { CODEX_SESSION_OVERRIDABLE_LAYER_TYPES } from "./config-layer-policy.js";
import { normalizeCodexDynamicToolName } from "./dynamic-tool-profile.js";
import type { CodexMultiAgentVersion } from "./model-runtime.js";
import type { CodexConfigReadResponse } from "./protocol-control-plane.js";
import { isJsonObject, type JsonObject, type JsonValue } from "./protocol.js";
import type { CodexAppServerThreadBinding } from "./session-binding.js";
import type {
  CodexPluginThreadConfigProvider,
  CodexStartOrResumeThreadParams,
} from "./thread-lifecycle-types.js";

type CodexMultiAgentConfiguration = {
  config?: JsonObject;
  effectiveConfig?: CodexConfigReadResponse;
};

export function shouldRotateCodexAppServerBindingForRuntime(params: {
  connectionClass: CodexAppServerConnectionClass;
  current?: string;
  binding?: string;
}): boolean {
  if (!params.current) {
    return false;
  }
  if (params.binding === params.current) {
    return false;
  }
  return params.connectionClass === "remote" || Boolean(params.binding);
}

export function resolveCodexMultiAgentVersion(
  modelRef: string | undefined,
  catalogVersion?: CodexMultiAgentVersion,
  configuration: CodexMultiAgentConfiguration = {},
): CodexMultiAgentVersion | undefined {
  // Native configuration overrides both model metadata and a retained generation.
  // Forced v2 wins even when agents.enabled is false.
  if (readCodexMultiAgentConfigFlag(configuration, "features.multi_agent_v2") === true) {
    return "v2";
  }
  if (readCodexMultiAgentConfigFlag(configuration, "agents.enabled") === false) {
    return "disabled";
  }
  if (catalogVersion !== undefined) {
    return catalogVersion;
  }
  // Older catalogs omit metadata. Preserve their existing compatibility rules.
  let modelId = modelRef?.trim().toLowerCase();
  if (!modelId) {
    return undefined;
  }
  const slashIndex = modelId.indexOf("/");
  if (slashIndex > 0) {
    const provider = modelId.slice(0, slashIndex);
    if (provider !== "openai" && provider !== "codex") {
      return undefined;
    }
    modelId = modelId.slice(slashIndex + 1);
  }
  if (modelId === "gpt-5.6-sol" || modelId === "gpt-5.6-terra") {
    return "v2";
  }
  return modelId === "gpt-5.6-luna" ? "v1" : undefined;
}

export function shouldRotateCodexMultiAgentBinding(
  params: CodexMultiAgentConfiguration & {
    bindingModel?: string;
    requestedModel: string;
    bindingVersion?: CodexMultiAgentVersion;
    requestedVersion?: CodexMultiAgentVersion;
  },
): boolean {
  const bindingVersion = resolveCodexMultiAgentVersion(
    params.bindingModel,
    params.bindingVersion,
    params,
  );
  const requestedVersion = resolveCodexMultiAgentVersion(
    params.requestedModel,
    params.requestedVersion,
    params,
  );
  return Boolean(bindingVersion && requestedVersion && bindingVersion !== requestedVersion);
}

export function isTransientWebSearchRestriction(
  params: Pick<
    CodexStartOrResumeThreadParams,
    | "params"
    | "nativeCodeModeEnabled"
    | "nativeProviderWebSearchSupport"
    | "persistentWebSearchAllowed"
    | "webSearchAllowed"
  >,
): boolean {
  if (params.nativeProviderWebSearchSupport === "unknown") {
    return true;
  }
  if (params.params.config?.tools?.web?.search?.enabled === false) {
    return false;
  }
  if (params.params.disableTools === true) {
    return true;
  }
  const persistentWebSearchRestriction =
    params.webSearchAllowed === false && params.persistentWebSearchAllowed === false;
  if (params.nativeCodeModeEnabled === false && !persistentWebSearchRestriction) {
    return true;
  }
  if (params.webSearchAllowed !== false) {
    return false;
  }
  if (params.persistentWebSearchAllowed !== undefined) {
    return params.persistentWebSearchAllowed;
  }
  if (params.params.toolsAllow === undefined) {
    return false;
  }
  return !params.params.toolsAllow.some((name) => {
    const normalized = normalizeCodexDynamicToolName(name);
    return normalized === "*" || normalized === "web_search";
  });
}
export function shouldRecheckRecoverablePluginBinding(params: {
  binding: CodexAppServerThreadBinding;
  pluginThreadConfig?: CodexPluginThreadConfigProvider;
}): boolean {
  if (!params.pluginThreadConfig?.enabled) {
    return false;
  }
  if (
    !params.binding.pluginAppsFingerprint ||
    !params.binding.pluginAppsInputFingerprint ||
    params.binding.pluginAppsInputFingerprint !== params.pluginThreadConfig.inputFingerprint
  ) {
    return false;
  }
  const policyContext = params.binding.pluginAppPolicyContext;
  if (!policyContext) {
    return false;
  }
  const enabledPluginConfigKeys = params.pluginThreadConfig.enabledPluginConfigKeys ?? [];
  const recoverablePluginConfigKeys =
    params.pluginThreadConfig.recoverablePluginConfigKeys ?? enabledPluginConfigKeys;
  const recoverablePluginConfigKeySet = new Set(recoverablePluginConfigKeys);
  const settledPluginConfigKeys = enabledPluginConfigKeys.filter(
    (configKey) => !recoverablePluginConfigKeySet.has(configKey),
  );
  const bindingContainsSettledPlugin = settledPluginConfigKeys.some(
    (configKey) =>
      (policyContext.pluginAppIds[configKey]?.length ?? 0) > 0 ||
      Object.values(policyContext.apps).some(
        (app) => app.source !== "account" && app.configKey === configKey,
      ),
  );
  const accountAppRecoveryEnabled =
    params.pluginThreadConfig.accountAppRecoveryEnabled ?? enabledPluginConfigKeys.length === 0;
  return (
    bindingContainsSettledPlugin ||
    (accountAppRecoveryEnabled && Object.keys(policyContext.apps).length === 0) ||
    recoverablePluginConfigKeys.length > 0
  );
}

function readCodexMultiAgentConfigFlag(
  configuration: CodexMultiAgentConfiguration,
  key: "features.multi_agent_v2" | "agents.enabled",
): boolean | undefined {
  const readFlag = (config: JsonObject | undefined) => {
    const value = readCodexMultiAgentConfigValue(config, key);
    if (typeof value === "boolean") {
      return value;
    }
    const enabled = readCodexMultiAgentConfigValue(config, `${key}.enabled`);
    return typeof enabled === "boolean" ? enabled : undefined;
  };
  const effective = configuration.effectiveConfig;
  const origin = effective?.origins?.[`${key}.enabled`] ?? effective?.origins?.[key];
  if (origin && !CODEX_SESSION_OVERRIDABLE_LAYER_TYPES.has(origin.name.type)) {
    return readFlag(effective?.config);
  }
  return readFlag(configuration.config) ?? readFlag(effective?.config);
}

function readCodexMultiAgentConfigValue(
  config: JsonObject | undefined,
  key: string,
): JsonValue | undefined {
  if (!config) {
    return undefined;
  }
  if (Object.hasOwn(config, key)) {
    return config[key];
  }
  const separator = key.lastIndexOf(".");
  if (separator < 0) {
    return undefined;
  }
  const parent = readCodexMultiAgentConfigValue(config, key.slice(0, separator));
  return isJsonObject(parent) ? parent[key.slice(separator + 1)] : undefined;
}
