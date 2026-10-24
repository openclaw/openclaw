/** Resolves agent runtime config, including SecretRef materialization for agent command use. */

import { collectClawToolPolicyCandidates } from "../claws/tool-policy-candidates.js";
import {
  getAgentRuntimeCommandSecretTargetIds,
  getAgentRuntimeOptionalCommandSecretPaths,
  getScopedChannelsCommandSecretTargets,
} from "../cli/command-secret-targets.js";
import { captureRuntimeConfigAsyncReader, readConfigFileSnapshotForWrite } from "../config/io.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isSecretRef } from "../config/types.secrets.js";
import { resolvePluginMetadataSnapshotAsync } from "../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { RuntimeEnv } from "../runtime.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../secrets/runtime-state.js";
import { discoverConfigSecretTargetsByIds } from "../secrets/target-registry.js";
import { listAgentEntries } from "./agent-scope.js";
import { measureAgentStartup } from "./startup-timing.js";

/** Loads runtime/source config and resolves command SecretRefs when the agent path needs them. */
export async function resolveAgentRuntimeConfig(
  runtime: RuntimeEnv,
  params?: {
    runtimeTargetsChannelSecrets?: boolean;
    runtimeChannelSecretScope?: { channel: string; accountId?: string };
  },
): Promise<OpenClawConfig> {
  const loadedRaw = await captureRuntimeConfigAsyncReader()();
  const includeChannelTargets = params?.runtimeTargetsChannelSecrets === true;
  const channelSecretScope = params?.runtimeChannelSecretScope;
  const channel = channelSecretScope?.channel;
  const hasRuntimeSecretRefs =
    hasNestedSecretRef(loadedRaw.models?.providers) ||
    hasNestedSecretRef(loadedRaw.memory?.search?.remote) ||
    listAgentEntries(loadedRaw).some((agent) =>
      hasNestedSecretRef({
        memoryRemote: agent.memory?.search?.remote,
        tts: agent.tts,
      }),
    ) ||
    hasNestedSecretRef(loadedRaw.tts) ||
    hasNestedSecretRef(loadedRaw.skills?.entries) ||
    hasNestedSecretRef(loadedRaw.tools?.web?.search) ||
    Object.values(loadedRaw.plugins?.entries ?? {}).some((entry) =>
      hasNestedSecretRef({
        webSearch: entry?.config?.webSearch,
        webFetch: entry?.config?.webFetch,
      }),
    ) ||
    hasNestedSecretRef(
      includeChannelTargets
        ? loadedRaw.channels
        : channel
          ? (loadedRaw.channels as Record<string, unknown> | undefined)?.[channel]
          : undefined,
    );
  const activeSecretsConfig = getActiveSecretsRuntimeConfigSnapshot();
  let pluginMetadataSnapshot: PluginMetadataSnapshot | undefined;
  const sourceConfig = activeSecretsConfig
    ? activeSecretsConfig.sourceConfig
    : await measureAgentStartup(
        "config-source",
        async () => {
          try {
            const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
            if (snapshot.valid) {
              pluginMetadataSnapshot = writeOptions.basePluginMetadataSnapshot;
              return snapshot.resolved;
            }
          } catch {
            // Fall back to runtime-loaded config when source snapshot is unavailable.
          }
          pluginMetadataSnapshot = await resolvePluginMetadataSnapshotAsync({ config: loadedRaw });
          return loadedRaw;
        },
        { config: loadedRaw },
      );
  let cfg = loadedRaw;
  if (hasRuntimeSecretRefs) {
    const baseTargetIds = getAgentRuntimeCommandSecretTargetIds({
      config: loadedRaw,
      includeChannelTargets,
    });
    const optionalActivePaths = getAgentRuntimeOptionalCommandSecretPaths(loadedRaw);
    let targetIds = baseTargetIds;
    let allowedPaths: Set<string> | undefined;
    if (!includeChannelTargets && channelSecretScope) {
      const channelTargets = getScopedChannelsCommandSecretTargets({
        config: loadedRaw,
        channel: channelSecretScope.channel,
        accountId: channelSecretScope.accountId,
        defaultAccountWhenMissing: true,
      });
      targetIds = new Set(baseTargetIds);
      for (const targetId of channelTargets.targetIds) {
        targetIds.add(targetId);
      }
      if (channelTargets.allowedPaths) {
        // Account scoping must not exclude the agent's model/tool secrets from the same resolution.
        allowedPaths = new Set(channelTargets.allowedPaths);
        for (const target of discoverConfigSecretTargetsByIds(loadedRaw, baseTargetIds)) {
          allowedPaths.add(target.path);
        }
      }
    }
    const { resolveCommandConfigWithSecrets } =
      await import("../cli/command-config-resolution.runtime.js");
    cfg = (
      await resolveCommandConfigWithSecrets({
        config: loadedRaw,
        commandName: "agent",
        targetIds,
        ...(allowedPaths ? { allowedPaths } : {}),
        ...(optionalActivePaths.size > 0 ? { optionalActivePaths } : {}),
        runtime,
      })
    ).resolvedConfig;
  }
  if (activeSecretsConfig && cfg !== loadedRaw) {
    // Gateway activation already published loadedRaw with this source config. Republishing the
    // same object here would advance its lifecycle revision and evict revision-keyed hot caches.
    setRuntimeConfigSnapshot(cfg, sourceConfig);
  } else if (!activeSecretsConfig) {
    // Standalone local agent commands have no Gateway-owned snapshot. Materialize
    // auth-profile refs too; resolving only config refs leaves selected credentials unusable.
    const secretsRuntime = await measureAgentStartup(
      "secrets-runtime-import",
      () => import("../secrets/runtime.js"),
      { config: cfg },
    );
    const hasClawToolPolicies = collectClawToolPolicyCandidates(cfg).length > 0;
    const [snapshot, provenance, clawToolPolicyRuntime] = await Promise.all([
      measureAgentStartup(
        "secrets-snapshot",
        () =>
          secretsRuntime.prepareSecretsRuntimeSnapshot({
            config: sourceConfig,
            assignmentConfig: cfg,
            includeConfigRefs: false,
            ...(pluginMetadataSnapshot ? { pluginMetadataSnapshot } : {}),
          }),
        { config: cfg },
      ),
      hasClawToolPolicies
        ? import("../claws/provenance-runtime-read.js").then(
            ({ prepareClawInstallSchemaVersions }) =>
              prepareClawInstallSchemaVersions({ artifactPreservingReadOnly: false }),
          )
        : undefined,
      hasClawToolPolicies ? import("../claws/tool-policy-runtime.js") : undefined,
    ]);
    provenance?.publish();
    secretsRuntime.activateSecretsRuntimeSnapshot(snapshot);
    // Activation publishes a clone; this caller retains the captured config.
    clawToolPolicyRuntime?.prepareCapturedClawToolPolicyConsent(cfg, {});
  }
  return cfg;
}

function hasNestedSecretRef(value: unknown): boolean {
  if (isSecretRef(value)) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some(hasNestedSecretRef);
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  return Object.values(value).some(hasNestedSecretRef);
}
