import type { CodexAppServerConnectionClass } from "./config-contracts.js";
import { normalizeCodexDynamicToolName } from "./dynamic-tool-profile.js";
import { normalizeCodexAppServerLocalRuntimeFingerprint } from "./plugin-app-cache-key.js";
import { isCodexPluginThreadBindingStale } from "./plugin-thread-config.js";
import type { CodexAppServerThreadBinding } from "./session-binding.js";
import type {
  CodexPluginThreadConfigProvider,
  CodexStartOrResumeThreadParams,
} from "./thread-lifecycle-types.js";

export function areCodexAppServerRuntimeFingerprintsCompatible(params: {
  connectionClass: CodexAppServerConnectionClass;
  current?: string;
  binding?: string;
}): boolean {
  if (!params.current || params.binding === params.current) {
    return true;
  }
  if (!params.binding) {
    return params.connectionClass !== "remote";
  }
  if (params.connectionClass === "local-loopback") {
    const normalizedCurrent = normalizeCodexAppServerLocalRuntimeFingerprint(params.current);
    const normalizedBinding = normalizeCodexAppServerLocalRuntimeFingerprint(params.binding);
    if (normalizedCurrent && normalizedBinding && normalizedCurrent === normalizedBinding) {
      return true;
    }
  }
  return false;
}

export function shouldRotateCodexAppServerBindingForRuntime(params: {
  connectionClass: CodexAppServerConnectionClass;
  current?: string;
  binding?: string;
}): boolean {
  return !areCodexAppServerRuntimeFingerprintsCompatible(params);
}

type CodexGpt56MultiAgentVersion = "v1" | "v2";

export function resolveCodexGpt56MultiAgentVersion(
  modelRef: string | undefined,
): CodexGpt56MultiAgentVersion | undefined {
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

export function shouldRotateCodexGpt56MultiAgentBinding(params: {
  bindingModel?: string;
  requestedModel: string;
}): boolean {
  const bindingVersion = resolveCodexGpt56MultiAgentVersion(params.bindingModel);
  const requestedVersion = resolveCodexGpt56MultiAgentVersion(params.requestedModel);
  return Boolean(bindingVersion && requestedVersion && bindingVersion !== requestedVersion);
}

export function isTransientWebSearchRestriction(
  params: Pick<
    CodexStartOrResumeThreadParams,
    "params" | "nativeProviderWebSearchSupport" | "persistentWebSearchAllowed" | "webSearchAllowed"
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
export function shouldRotateCodexPluginThreadBinding(
  binding: CodexAppServerThreadBinding,
  pluginThreadConfig?: CodexPluginThreadConfigProvider,
): boolean {
  if (
    !isCodexPluginThreadBindingStale({
      codexPluginsEnabled: pluginThreadConfig?.enabled ?? false,
      bindingFingerprint: binding.pluginAppsFingerprint,
      bindingInputFingerprint: binding.pluginAppsInputFingerprint,
      currentInputFingerprint: pluginThreadConfig?.inputFingerprint,
      hasBindingPolicyContext: Boolean(binding.pluginAppPolicyContext),
    })
  ) {
    return false;
  }
  return !(
    pluginThreadConfig?.enabled &&
    binding.pluginAppsFingerprint &&
    binding.pluginAppsInputFingerprint &&
    binding.pluginAppPolicyContext &&
    pluginThreadConfig.matchesLegacyBindingInputFingerprint?.(binding) === true
  );
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
    (params.binding.pluginAppsInputFingerprint !== params.pluginThreadConfig.inputFingerprint &&
      params.pluginThreadConfig.matchesLegacyBindingInputFingerprint?.(params.binding) !== true)
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
  const bindingContainsSettledPlugin = enabledPluginConfigKeys.some(
    (configKey) =>
      !recoverablePluginConfigKeySet.has(configKey) &&
      ((policyContext.pluginAppIds[configKey]?.length ?? 0) > 0 ||
        Object.values(policyContext.apps).some(
          (app) => app.source !== "account" && app.configKey === configKey,
        )),
  );
  const accountAppRecoveryEnabled =
    params.pluginThreadConfig.accountAppRecoveryEnabled ?? enabledPluginConfigKeys.length === 0;
  return (
    bindingContainsSettledPlugin ||
    (accountAppRecoveryEnabled && Object.keys(policyContext.apps).length === 0) ||
    recoverablePluginConfigKeys.length > 0
  );
}
