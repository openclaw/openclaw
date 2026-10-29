import { fingerprintCodexPolicy } from "./config-policy-json.js";
import { resolveCodexPluginsPolicy, type ResolvedCodexPluginsPolicy } from "./config.js";
import type { JsonValue } from "./protocol.js";

const CODEX_PLUGIN_THREAD_CONFIG_INPUT_FINGERPRINT_VERSION = 16;

export function shouldBuildCodexPluginThreadConfig(pluginConfig?: unknown): boolean {
  return resolveCodexPluginsPolicy(pluginConfig).configured;
}

/** Fingerprints policy and app-cache identity before runtime inventory is read. */
export function buildCodexPluginThreadConfigInputFingerprint(params: {
  pluginConfig?: unknown;
  appCacheKey?: string;
}): string {
  const policy = resolveCodexPluginsPolicy(params.pluginConfig);
  return fingerprintCodexPolicy({
    version: CODEX_PLUGIN_THREAD_CONFIG_INPUT_FINGERPRINT_VERSION,
    policy: policyFingerprint(policy),
    appCacheKey: params.appCacheKey ?? null,
  });
}

function policyFingerprint(policy: ResolvedCodexPluginsPolicy): JsonValue {
  return {
    enabled: policy.enabled,
    allowAllPlugins: policy.allowAllPlugins,
    allowDestructiveActions: policy.allowDestructiveActions,
    destructiveApprovalMode: policy.destructiveApprovalMode,
    plugins: policy.pluginPolicies.map((plugin) => ({
      configKey: plugin.configKey,
      marketplaceName: plugin.marketplaceName,
      pluginName: plugin.pluginName,
      enabled: plugin.enabled,
      ...(policy.enabled && plugin.enabled && plugin.readOnly
        ? { readOnlyToolIdentity: "mcp-resource" }
        : {}),
      allowDestructiveActions: plugin.allowDestructiveActions,
      destructiveApprovalMode: plugin.destructiveApprovalMode,
    })),
  };
}
