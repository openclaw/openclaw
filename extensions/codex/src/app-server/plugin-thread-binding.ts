import {
  buildPluginAppPolicyContext,
  fingerprintCodexPluginThreadConfig,
  type CodexPluginThreadConfig,
  type PluginAppPolicyContext,
} from "./plugin-thread-config.js";
import { isJsonObject } from "./protocol.js";

export function isCodexPluginThreadBindingStale(params: {
  codexPluginsEnabled: boolean;
  bindingFingerprint?: string;
  bindingInputFingerprint?: string;
  currentInputFingerprint?: string;
  hasBindingPolicyContext?: boolean;
}): boolean {
  if (!params.codexPluginsEnabled) {
    return Boolean(
      params.bindingFingerprint || params.bindingInputFingerprint || params.hasBindingPolicyContext,
    );
  }
  if (
    !params.bindingFingerprint ||
    !params.bindingInputFingerprint ||
    !params.hasBindingPolicyContext
  ) {
    return true;
  }
  return params.bindingInputFingerprint !== params.currentInputFingerprint;
}

/** A new admission input requires revalidation, not necessarily a new native thread. */
export function hasUnchangedCodexPluginThreadPolicy(params: {
  bindingFingerprint: string;
  bindingInputFingerprint: string;
  config: CodexPluginThreadConfig;
}): boolean {
  return (
    params.bindingFingerprint ===
    fingerprintCodexPluginThreadConfig({
      inputFingerprint: params.bindingInputFingerprint,
      configPatch: params.config.configPatch,
      policyContext: params.config.policyContext,
    })
  );
}

/** Only new admitted apps may differ before an upgraded executor's checked cold resume. */
export function hasOnlyAddedCodexPluginApps(params: {
  bindingFingerprint: string;
  bindingInputFingerprint: string;
  bindingPolicyContext: PluginAppPolicyContext;
  config: CodexPluginThreadConfig;
}): boolean {
  const addedAppIds = new Set(
    Object.keys(params.config.policyContext.apps).filter(
      (id) => !Object.hasOwn(params.bindingPolicyContext.apps, id),
    ),
  );
  if (addedAppIds.size === 0 || !isJsonObject(params.config.configPatch?.apps)) {
    return false;
  }
  const apps = { ...params.config.configPatch.apps };
  const policyApps = { ...params.config.policyContext.apps };
  for (const id of addedAppIds) {
    if (!isJsonObject(apps[id]) || apps[id].enabled !== true) {
      return false;
    }
    delete apps[id];
    delete policyApps[id];
  }
  const pluginAppIds: PluginAppPolicyContext["pluginAppIds"] = {};
  for (const [key, ids] of Object.entries(params.config.policyContext.pluginAppIds)) {
    const retained = ids.filter((id) => !addedAppIds.has(id));
    if (
      ids.length === 0 ||
      retained.length > 0 ||
      Object.hasOwn(params.bindingPolicyContext.pluginAppIds, key)
    ) {
      pluginAppIds[key] = retained;
    }
  }
  // The full old fingerprint also covers defaults, per-tool approvals and unknown
  // config fields. Comparing just app grants would miss changes in those layers.
  return hasUnchangedCodexPluginThreadPolicy({
    ...params,
    config: {
      ...params.config,
      configPatch: { ...params.config.configPatch, apps },
      policyContext: buildPluginAppPolicyContext(policyApps, pluginAppIds),
    },
  });
}
