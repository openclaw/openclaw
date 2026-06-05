/**
 * Optional media tool factory planner.
 *
 * Combines config, tool policy, plugin capability metadata, and auth-profile availability before tool construction.
 */
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../config/model-input.js";
import type { AgentModelConfig } from "../config/types.agents-shared.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { listProfilesForProvider } from "./auth-profiles/profile-list.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { isToolAllowedByPolicyName } from "./tool-policy-match.js";
import { DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY } from "./tool-policy.js";
import {
  getCurrentCapabilityMetadataSnapshot,
  hasSnapshotCapabilityAvailability,
  hasSnapshotProviderEnvAvailability,
  loadCapabilityMetadataSnapshot,
} from "./tools/manifest-capability-availability.js";

/**
 * Plans optional media-tool factory registration from config, policy, capabilities, and auth.
 */
export type OptionalMediaToolFactoryPlan = {
  image: boolean;
  imageGenerate: boolean;
  videoGenerate: boolean;
  musicGenerate: boolean;
  pdf: boolean;
};

type ToolModelConfig = { primary?: string; fallbacks?: string[] };

function coerceFactoryToolModelConfig(model?: AgentModelConfig): ToolModelConfig {
  const primary = resolveAgentModelPrimaryValue(model);
  const fallbacks = resolveAgentModelFallbackValues(model);
  return {
    ...(primary?.trim() ? { primary: primary.trim() } : {}),
    ...(fallbacks.length > 0 ? { fallbacks } : {}),
  };
}

function hasToolModelConfig(model: ToolModelConfig | undefined): boolean {
  return Boolean(
    model?.primary?.trim() || (model?.fallbacks ?? []).some((entry) => entry.trim().length > 0),
  );
}

function hasExplicitToolModelConfig(modelConfig: AgentModelConfig | undefined): boolean {
  return hasToolModelConfig(coerceFactoryToolModelConfig(modelConfig));
}

function hasExplicitImageModelConfig(config: OpenClawConfig | undefined): boolean {
  return hasExplicitToolModelConfig(config?.agents?.defaults?.imageModel);
}

function hasExplicitPdfModelConfig(config: OpenClawConfig | undefined): boolean {
  return (
    hasExplicitToolModelConfig(config?.agents?.defaults?.pdfModel) ||
    hasExplicitImageModelConfig(config)
  );
}

function isToolAllowedByFactoryPolicy(params: {
  toolName: string;
  allowlist?: string[];
  denylist?: string[];
}): boolean {
  return isToolAllowedByPolicyName(params.toolName, {
    allow: params.allowlist,
    deny: params.denylist,
  });
}

function hasExplicitWorkspaceManifestPlugin(params: {
  snapshot: Pick<PluginMetadataSnapshot, "plugins"> | undefined;
}): boolean {
  return params.snapshot?.plugins.some((plugin) => plugin.origin === "workspace") ?? false;
}

/** Returns true only when an allowlist explicitly enables the requested tool. */
export function isToolExplicitlyAllowedByFactoryPolicy(params: {
  toolName: string;
  allowlist?: string[];
  denylist?: string[];
}): boolean {
  if (!params.allowlist?.some((entry) => typeof entry === "string" && entry.trim().length > 0)) {
    return false;
  }
  return isToolAllowedByFactoryPolicy(params);
}

/** Merges factory policy lists while preserving stable unique entries. */
export function mergeFactoryPolicyList(
  ...lists: Array<string[] | undefined>
): string[] | undefined {
  const merged = lists.flatMap((list) => (Array.isArray(list) ? list : []));
  return merged.length > 0 ? uniqueStrings(merged) : undefined;
}

function mergeBuiltInFactoryAllowlist(...lists: Array<string[] | undefined>): string[] | undefined {
  const allowlist = mergeFactoryPolicyList(...lists);
  if (
    !allowlist?.some(
      (entry) => typeof entry === "string" && entry.trim() === DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY,
    )
  ) {
    return allowlist;
  }
  const withoutDefaultPluginMarker = allowlist.filter(
    (entry) => typeof entry !== "string" || entry.trim() !== DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY,
  );
  return uniqueStrings(["*", ...withoutDefaultPluginMarker]);
}

/** Returns whether the image understanding tool can be constructed for this agent context. */
export function resolveImageToolFactoryAvailable(params: {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  modelHasVision?: boolean;
  authStore?: AuthProfileStore;
}): boolean {
  const snapshot = loadCapabilityMetadataSnapshot({
    config: params.config,
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
  });
  return resolveImageToolFactoryAvailableFromSnapshot({
    ...params,
    snapshot,
  });
}

function resolveImageToolFactoryAvailableFromSnapshot(params: {
  config?: OpenClawConfig;
  agentDir?: string;
  modelHasVision?: boolean;
  authStore?: AuthProfileStore;
  snapshot?: Pick<PluginMetadataSnapshot, "index" | "plugins">;
}): boolean {
  if (!params.agentDir?.trim()) {
    return false;
  }
  if (params.modelHasVision || hasExplicitImageModelConfig(params.config)) {
    return true;
  }
  if (!params.snapshot) {
    return false;
  }
  return (
    hasSnapshotCapabilityAvailability({
      snapshot: params.snapshot,
      authStore: params.authStore,
      key: "mediaUnderstandingProviders",
      config: params.config,
    }) ||
    hasConfiguredVisionModelAuthSignal({
      config: params.config,
      snapshot: params.snapshot,
      authStore: params.authStore,
    })
  );
}

function hasConfiguredVisionModelAuthSignal(params: {
  config?: OpenClawConfig;
  snapshot: Pick<PluginMetadataSnapshot, "index" | "plugins">;
  authStore?: AuthProfileStore;
}): boolean {
  const providers = params.config?.models?.providers;
  if (!providers || typeof providers !== "object") {
    return false;
  }
  for (const [providerId, providerConfig] of Object.entries(providers)) {
    if (
      !providerConfig?.models?.some(
        (model) => Array.isArray(model?.input) && model.input.includes("image"),
      )
    ) {
      continue;
    }
    if (params.authStore && listProfilesForProvider(params.authStore, providerId).length > 0) {
      return true;
    }
    if (
      hasSnapshotProviderEnvAvailability({
        snapshot: params.snapshot,
        providerId,
        config: params.config,
      })
    ) {
      return true;
    }
  }
  return false;
}

/** Resolves which optional media tools should be created for the current tool factory call. */
export function resolveOptionalMediaToolFactoryPlan(params: {
  config?: OpenClawConfig;
  agentDir?: string;
  modelHasVision?: boolean;
  workspaceDir?: string;
  authStore?: AuthProfileStore;
  toolAllowlist?: string[];
  toolDenylist?: string[];
}): OptionalMediaToolFactoryPlan {
  const defaults = params.config?.agents?.defaults;
  const toolAllowlist = mergeBuiltInFactoryAllowlist(
    params.config?.tools?.allow,
    params.toolAllowlist,
  );
  const toolDenylist = mergeFactoryPolicyList(params.config?.tools?.deny, params.toolDenylist);
  const allowImageGenerate = isToolAllowedByFactoryPolicy({
    toolName: "image_generate",
    allowlist: toolAllowlist,
    denylist: toolDenylist,
  });
  const allowVideoGenerate = isToolAllowedByFactoryPolicy({
    toolName: "video_generate",
    allowlist: toolAllowlist,
    denylist: toolDenylist,
  });
  const allowMusicGenerate = isToolAllowedByFactoryPolicy({
    toolName: "music_generate",
    allowlist: toolAllowlist,
    denylist: toolDenylist,
  });
  const allowPdf = isToolAllowedByFactoryPolicy({
    toolName: "pdf",
    allowlist: toolAllowlist,
    denylist: toolDenylist,
  });
  const explicitImageGeneration = hasExplicitToolModelConfig(defaults?.mediaModels?.image);
  const explicitVideoGeneration = hasExplicitToolModelConfig(defaults?.mediaModels?.video);
  const explicitMusicGeneration = hasExplicitToolModelConfig(defaults?.mediaModels?.music);
  const explicitPdf = hasExplicitPdfModelConfig(params.config);
  const snapshot =
    params.config?.plugins?.enabled === false
      ? undefined
      : loadCapabilityMetadataSnapshot({
          config: params.config,
          ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
        });
  const imageSnapshot = params.workspaceDir
    ? (getCurrentCapabilityMetadataSnapshot({
        config: params.config,
        workspaceDir: params.workspaceDir,
      }) ?? (hasExplicitWorkspaceManifestPlugin({ snapshot }) ? snapshot : undefined))
    : snapshot;
  const image = resolveImageToolFactoryAvailableFromSnapshot({
    config: params.config,
    agentDir: params.agentDir,
    modelHasVision: params.modelHasVision,
    authStore: params.authStore,
    snapshot: imageSnapshot,
  });
  if (params.config?.plugins?.enabled === false) {
    // Optional media tools are plugin/capability backed. Disabling plugins shuts them off even when
    // stale defaults or env availability would otherwise appear to make a tool available.
    return {
      image,
      imageGenerate: false,
      videoGenerate: false,
      musicGenerate: false,
      pdf: false,
    };
  }
  if (!snapshot) {
    return {
      image,
      imageGenerate: false,
      videoGenerate: false,
      musicGenerate: false,
      pdf: false,
    };
  }
  const availabilitySnapshot = snapshot;
  return {
    image,
    imageGenerate:
      allowImageGenerate &&
      (explicitImageGeneration ||
        hasSnapshotCapabilityAvailability({
          snapshot: availabilitySnapshot,
          authStore: params.authStore,
          key: "imageGenerationProviders",
          config: params.config,
        })),
    videoGenerate:
      allowVideoGenerate &&
      (explicitVideoGeneration ||
        hasSnapshotCapabilityAvailability({
          snapshot: availabilitySnapshot,
          authStore: params.authStore,
          key: "videoGenerationProviders",
          config: params.config,
        })),
    musicGenerate:
      allowMusicGenerate &&
      (explicitMusicGeneration ||
        hasSnapshotCapabilityAvailability({
          snapshot: availabilitySnapshot,
          authStore: params.authStore,
          key: "musicGenerationProviders",
          config: params.config,
        })),
    pdf:
      allowPdf &&
      (explicitPdf ||
        hasSnapshotCapabilityAvailability({
          snapshot: availabilitySnapshot,
          authStore: params.authStore,
          key: "mediaUnderstandingProviders",
          config: params.config,
        }) ||
        hasConfiguredVisionModelAuthSignal({
          config: params.config,
          snapshot: availabilitySnapshot,
          authStore: params.authStore,
        })),
  };
}
