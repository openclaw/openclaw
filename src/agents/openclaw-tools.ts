import type { AgentModelConfig } from "../config/types.agents-shared.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGateway } from "../gateway/call.js";
import { isEmbeddedMode } from "../infra/embedded-mode.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { getActiveRuntimeWebToolsMetadata } from "../secrets/runtime.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.js";
import type { GatewayMessageChannel } from "../utils/message-channel.js";
import { resolveAgentWorkspaceDir, resolveSessionAgentIds } from "./agent-scope.js";
import { listProfilesForProvider } from "./auth-profiles.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { resolveOpenClawPluginToolsForOptions } from "./openclaw-plugin-tools.js";
import { applyNodesToolWorkspaceGuard } from "./openclaw-tools.nodes-workspace-guard.js";
import {
  collectPresentOpenClawTools,
  isUpdatePlanToolEnabledForOpenClawTools,
} from "./openclaw-tools.registration.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";
import type { SpawnedToolContext } from "./spawned-context.js";
import type { ToolFsPolicy } from "./tool-fs-policy.js";
import { expandToolGroups, normalizeToolName } from "./tool-policy.js";
import { createAgentsListTool } from "./tools/agents-list-tool.js";
import { createCanvasTool } from "./tools/canvas-tool.js";
import type { AnyAgentTool } from "./tools/common.js";
import { createCronTool } from "./tools/cron-tool.js";
import { createEmbeddedCallGateway } from "./tools/embedded-gateway-stub.js";
import { createGatewayTool } from "./tools/gateway-tool.js";
import { createHeartbeatResponseTool } from "./tools/heartbeat-response-tool.js";
import { createImageGenerateTool } from "./tools/image-generate-tool.js";
import { coerceImageModelConfig } from "./tools/image-tool.helpers.js";
import { createImageTool } from "./tools/image-tool.js";
import { createMessageTool } from "./tools/message-tool.js";
import { coerceToolModelConfig, hasToolModelConfig } from "./tools/model-config.helpers.js";
import { createMusicGenerateTool } from "./tools/music-generate-tool.js";
import { createNodesTool } from "./tools/nodes-tool.js";
import { coercePdfModelConfig } from "./tools/pdf-tool.helpers.js";
import { createPdfTool } from "./tools/pdf-tool.js";
import { createSessionStatusTool } from "./tools/session-status-tool.js";
import { createSessionsHistoryTool } from "./tools/sessions-history-tool.js";
import { createSessionsListTool } from "./tools/sessions-list-tool.js";
import { createSessionsSendTool } from "./tools/sessions-send-tool.js";
import { createSessionsSpawnTool } from "./tools/sessions-spawn-tool.js";
import { createSessionsYieldTool } from "./tools/sessions-yield-tool.js";
import { createSubagentsTool } from "./tools/subagents-tool.js";
import { createTtsTool } from "./tools/tts-tool.js";
import { createUpdatePlanTool } from "./tools/update-plan-tool.js";
import { createVideoGenerateTool } from "./tools/video-generate-tool.js";
import { createWebFetchTool, createWebSearchTool } from "./tools/web-tools.js";
import { resolveWorkspaceRoot } from "./workspace-dir.js";

type OpenClawToolsDeps = {
  callGateway: typeof callGateway;
  config?: OpenClawConfig;
};

const defaultOpenClawToolsDeps: OpenClawToolsDeps = {
  callGateway,
};

let openClawToolsDeps: OpenClawToolsDeps = defaultOpenClawToolsDeps;

type CapabilityContractKey =
  | "imageGenerationProviders"
  | "videoGenerationProviders"
  | "musicGenerationProviders"
  | "mediaUnderstandingProviders";

type OptionalMediaToolFactoryPlan = {
  imageGenerate: boolean;
  videoGenerate: boolean;
  musicGenerate: boolean;
  pdf: boolean;
};

function hasExplicitToolModelConfig(modelConfig: AgentModelConfig | undefined): boolean {
  return hasToolModelConfig(coerceToolModelConfig(modelConfig));
}

function isToolAllowedByFactoryAllowlist(toolName: string, allowlist?: string[]): boolean {
  if (!allowlist || allowlist.length === 0) {
    return true;
  }
  const expanded = new Set(expandToolGroups(allowlist));
  return expanded.has("*") || expanded.has(normalizeToolName(toolName));
}

function pluginSetupProviderEnvVars(
  plugin: PluginManifestRecord,
  providerId: string,
): readonly string[] {
  const direct = plugin.setup?.providers?.find((provider) => provider.id === providerId)?.envVars;
  if (direct && direct.length > 0) {
    return direct;
  }
  // This is a deprecated fallback for older plugin versions that didn't have per-provider env var declarations. Do not use, will be removed after a grace period.
  return plugin.providerAuthEnvVars?.[providerId] ?? [];
}

function hasNonEmptyEnvCandidate(envVars: readonly string[]): boolean {
  return envVars.some((envVar) => {
    const key = envVar.trim();
    return key.length > 0 && Boolean(process.env[key]?.trim());
  });
}

function hasAuthSignalForSnapshotCapability(params: {
  snapshot: PluginMetadataSnapshot;
  authStore: AuthProfileStore;
  key: CapabilityContractKey;
}): boolean {
  for (const plugin of params.snapshot.plugins) {
    if (plugin.origin !== "bundled") {
      continue;
    }
    for (const providerId of plugin.contracts?.[params.key] ?? []) {
      if (listProfilesForProvider(params.authStore, providerId).length > 0) {
        return true;
      }
      if (hasNonEmptyEnvCandidate(pluginSetupProviderEnvVars(plugin, providerId))) {
        return true;
      }
    }
  }
  return false;
}

function hasConfiguredVisionModelAuthSignal(params: {
  config?: OpenClawConfig;
  snapshot: PluginMetadataSnapshot;
  authStore: AuthProfileStore;
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
    if (listProfilesForProvider(params.authStore, providerId).length > 0) {
      return true;
    }
    for (const plugin of params.snapshot.plugins) {
      if (plugin.origin !== "bundled") {
        continue;
      }
      if (hasNonEmptyEnvCandidate(pluginSetupProviderEnvVars(plugin, providerId))) {
        return true;
      }
    }
  }
  return false;
}

function resolveOptionalMediaToolFactoryPlan(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  authStore?: AuthProfileStore;
  toolAllowlist?: string[];
}): OptionalMediaToolFactoryPlan {
  const defaults = params.config?.agents?.defaults;
  const allowImageGenerate = isToolAllowedByFactoryAllowlist(
    "image_generate",
    params.toolAllowlist,
  );
  const allowVideoGenerate = isToolAllowedByFactoryAllowlist(
    "video_generate",
    params.toolAllowlist,
  );
  const allowMusicGenerate = isToolAllowedByFactoryAllowlist(
    "music_generate",
    params.toolAllowlist,
  );
  const allowPdf = isToolAllowedByFactoryAllowlist("pdf", params.toolAllowlist);
  const explicitImageGeneration = hasExplicitToolModelConfig(defaults?.imageGenerationModel);
  const explicitVideoGeneration = hasExplicitToolModelConfig(defaults?.videoGenerationModel);
  const explicitMusicGeneration = hasExplicitToolModelConfig(defaults?.musicGenerationModel);
  const explicitPdf =
    hasToolModelConfig(coercePdfModelConfig(params.config)) ||
    hasToolModelConfig(coerceImageModelConfig(params.config));
  const fallbackPlan: OptionalMediaToolFactoryPlan = {
    imageGenerate: allowImageGenerate,
    videoGenerate: allowVideoGenerate,
    musicGenerate: allowMusicGenerate,
    pdf: allowPdf,
  };
  if (!params.authStore) {
    return fallbackPlan;
  }
  const snapshot = getCurrentPluginMetadataSnapshot({
    config: params.config,
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
  });
  if (!snapshot) {
    return fallbackPlan;
  }
  return {
    imageGenerate:
      allowImageGenerate &&
      (explicitImageGeneration ||
        hasAuthSignalForSnapshotCapability({
          snapshot,
          authStore: params.authStore,
          key: "imageGenerationProviders",
        })),
    videoGenerate:
      allowVideoGenerate &&
      (explicitVideoGeneration ||
        hasAuthSignalForSnapshotCapability({
          snapshot,
          authStore: params.authStore,
          key: "videoGenerationProviders",
        })),
    musicGenerate:
      allowMusicGenerate &&
      (explicitMusicGeneration ||
        hasAuthSignalForSnapshotCapability({
          snapshot,
          authStore: params.authStore,
          key: "musicGenerationProviders",
        })),
    pdf:
      allowPdf &&
      (explicitPdf ||
        hasAuthSignalForSnapshotCapability({
          snapshot,
          authStore: params.authStore,
          key: "mediaUnderstandingProviders",
        }) ||
        hasConfiguredVisionModelAuthSignal({
          config: params.config,
          snapshot,
          authStore: params.authStore,
        })),
  };
}

export function createOpenClawTools(
  options?: {
    sandboxBrowserBridgeUrl?: string;
    allowHostBrowserControl?: boolean;
    agentSessionKey?: string;
    agentChannel?: GatewayMessageChannel;
    agentAccountId?: string;
    /** Delivery target for topic/thread routing. */
    agentTo?: string;
    /** Thread/topic identifier for routing replies to the originating thread. */
    agentThreadId?: string | number;
    agentDir?: string;
    sandboxRoot?: string;
    sandboxContainerWorkdir?: string;
    sandboxFsBridge?: SandboxFsBridge;
    fsPolicy?: ToolFsPolicy;
    sandboxed?: boolean;
    config?: OpenClawConfig;
    pluginToolAllowlist?: string[];
    /** Current channel ID for auto-threading. */
    currentChannelId?: string;
    /** Current thread timestamp for auto-threading. */
    currentThreadTs?: string;
    /** Current inbound message id for action fallbacks. */
    currentMessageId?: string | number;
    /** Reply-to mode for auto-threading. */
    replyToMode?: "off" | "first" | "all" | "batched";
    /** Mutable ref to track if a reply was sent (for "first" mode). */
    hasRepliedRef?: { value: boolean };
    /** If true, the model has native vision capability */
    modelHasVision?: boolean;
    /** Active model provider for provider-specific tool gating. */
    modelProvider?: string;
    /** Active model id for provider/model-specific tool gating. */
    modelId?: string;
    /** If true, nodes action="invoke" can call media-returning commands directly. */
    allowMediaInvokeCommands?: boolean;
    /** Explicit agent ID override for cron/hook sessions. */
    requesterAgentIdOverride?: string;
    /** Restrict the cron tool to self-removing this active cron job. */
    cronSelfRemoveOnlyJobId?: string;
    /** Require explicit message targets (no implicit last-route sends). */
    requireExplicitMessageTarget?: boolean;
    /** If true, omit the message tool from the tool list. */
    disableMessageTool?: boolean;
    /** If true, include the heartbeat response tool for structured heartbeat outcomes. */
    enableHeartbeatTool?: boolean;
    /** If true, skip plugin tool resolution and return only shipped core tools. */
    disablePluginTools?: boolean;
    /** Records hot-path tool-prep stages for reply startup diagnostics. */
    recordToolPrepStage?: (name: string) => void;
    /** Trusted sender id from inbound context (not tool args). */
    requesterSenderId?: string | null;
    /** Auth profiles already loaded for this run; used for prompt-time tool availability. */
    authProfileStore?: AuthProfileStore;
    /** Whether the requesting sender is an owner. */
    senderIsOwner?: boolean;
    /** Ephemeral session UUID — regenerated on /new and /reset. */
    sessionId?: string;
    /**
     * Workspace directory to pass to spawned subagents for inheritance.
     * Defaults to workspaceDir. Use this to pass the actual agent workspace when the
     * session itself is running in a copied-workspace sandbox (`ro` or `none`) so
     * subagents inherit the real workspace path instead of the sandbox copy.
     */
    spawnWorkspaceDir?: string;
    /** Callback invoked when sessions_yield tool is called. */
    onYield?: (message: string) => Promise<void> | void;
    /** Allow plugin tools for this tool set to late-bind the gateway subagent. */
    allowGatewaySubagentBinding?: boolean;
  } & SpawnedToolContext,
): AnyAgentTool[] {
  const resolvedConfig = options?.config ?? openClawToolsDeps.config;
  const { sessionAgentId } = resolveSessionAgentIds({
    sessionKey: options?.agentSessionKey,
    config: resolvedConfig,
    agentId: options?.requesterAgentIdOverride,
  });
  // Fall back to the session agent workspace so plugin loading stays workspace-stable
  // even when a caller forgets to thread workspaceDir explicitly.
  const inferredWorkspaceDir =
    options?.workspaceDir || !resolvedConfig
      ? undefined
      : resolveAgentWorkspaceDir(resolvedConfig, sessionAgentId);
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir ?? inferredWorkspaceDir);
  const spawnWorkspaceDir = resolveWorkspaceRoot(
    options?.spawnWorkspaceDir ?? options?.workspaceDir ?? inferredWorkspaceDir,
  );
  options?.recordToolPrepStage?.("openclaw-tools:session-workspace");
  const deliveryContext = normalizeDeliveryContext({
    channel: options?.agentChannel,
    to: options?.agentTo,
    accountId: options?.agentAccountId,
    threadId: options?.agentThreadId,
  });
  const runtimeWebTools = getActiveRuntimeWebToolsMetadata();
  const sandbox =
    options?.sandboxRoot && options?.sandboxFsBridge
      ? { root: options.sandboxRoot, bridge: options.sandboxFsBridge }
      : undefined;
  const optionalMediaTools = resolveOptionalMediaToolFactoryPlan({
    config: resolvedConfig,
    workspaceDir,
    authStore: options?.authProfileStore,
    toolAllowlist: options?.pluginToolAllowlist,
  });
  const imageTool = options?.agentDir?.trim()
    ? createImageTool({
        config: options?.config,
        agentDir: options.agentDir,
        authProfileStore: options?.authProfileStore,
        workspaceDir,
        sandbox,
        fsPolicy: options?.fsPolicy,
        modelHasVision: options?.modelHasVision,
      })
    : null;
  options?.recordToolPrepStage?.("openclaw-tools:image-tool");
  const imageGenerateTool = optionalMediaTools.imageGenerate
    ? createImageGenerateTool({
        config: options?.config,
        agentDir: options?.agentDir,
        authProfileStore: options?.authProfileStore,
        workspaceDir,
        sandbox,
        fsPolicy: options?.fsPolicy,
      })
    : null;
  options?.recordToolPrepStage?.("openclaw-tools:image-generate-tool");
  const videoGenerateTool = optionalMediaTools.videoGenerate
    ? createVideoGenerateTool({
        config: options?.config,
        agentDir: options?.agentDir,
        authProfileStore: options?.authProfileStore,
        agentSessionKey: options?.agentSessionKey,
        requesterOrigin: deliveryContext ?? undefined,
        workspaceDir,
        sandbox,
        fsPolicy: options?.fsPolicy,
      })
    : null;
  options?.recordToolPrepStage?.("openclaw-tools:video-generate-tool");
  const musicGenerateTool = optionalMediaTools.musicGenerate
    ? createMusicGenerateTool({
        config: options?.config,
        agentDir: options?.agentDir,
        authProfileStore: options?.authProfileStore,
        agentSessionKey: options?.agentSessionKey,
        requesterOrigin: deliveryContext ?? undefined,
        workspaceDir,
        sandbox,
        fsPolicy: options?.fsPolicy,
      })
    : null;
  options?.recordToolPrepStage?.("openclaw-tools:music-generate-tool");
  const pdfTool =
    optionalMediaTools.pdf && options?.agentDir?.trim()
      ? createPdfTool({
          config: options?.config,
          agentDir: options.agentDir,
          authProfileStore: options?.authProfileStore,
          workspaceDir,
          sandbox,
          fsPolicy: options?.fsPolicy,
        })
      : null;
  options?.recordToolPrepStage?.("openclaw-tools:pdf-tool");
  const webSearchTool = createWebSearchTool({
    config: options?.config,
    sandboxed: options?.sandboxed,
    runtimeWebSearch: runtimeWebTools?.search,
    lateBindRuntimeConfig: true,
  });
  options?.recordToolPrepStage?.("openclaw-tools:web-search-tool");
  const webFetchTool = createWebFetchTool({
    config: options?.config,
    sandboxed: options?.sandboxed,
    runtimeWebFetch: runtimeWebTools?.fetch,
  });
  options?.recordToolPrepStage?.("openclaw-tools:web-fetch-tool");
  const messageTool = options?.disableMessageTool
    ? null
    : createMessageTool({
        agentAccountId: options?.agentAccountId,
        agentSessionKey: options?.agentSessionKey,
        sessionId: options?.sessionId,
        config: options?.config,
        currentChannelId: options?.currentChannelId,
        currentChannelProvider: options?.agentChannel,
        currentThreadTs: options?.currentThreadTs,
        currentMessageId: options?.currentMessageId,
        replyToMode: options?.replyToMode,
        hasRepliedRef: options?.hasRepliedRef,
        sandboxRoot: options?.sandboxRoot,
        requireExplicitTarget: options?.requireExplicitMessageTarget,
        requesterSenderId: options?.requesterSenderId ?? undefined,
        senderIsOwner: options?.senderIsOwner,
      });
  const heartbeatTool = options?.enableHeartbeatTool ? createHeartbeatResponseTool() : null;
  options?.recordToolPrepStage?.("openclaw-tools:message-tool");
  const nodesToolBase = createNodesTool({
    agentSessionKey: options?.agentSessionKey,
    agentChannel: options?.agentChannel,
    agentAccountId: options?.agentAccountId,
    currentChannelId: options?.currentChannelId,
    currentThreadTs: options?.currentThreadTs,
    config: options?.config,
    modelHasVision: options?.modelHasVision,
    allowMediaInvokeCommands: options?.allowMediaInvokeCommands,
  });
  const nodesTool = applyNodesToolWorkspaceGuard(nodesToolBase, {
    fsPolicy: options?.fsPolicy,
    sandboxContainerWorkdir: options?.sandboxContainerWorkdir,
    sandboxRoot: options?.sandboxRoot,
    workspaceDir,
  });
  options?.recordToolPrepStage?.("openclaw-tools:nodes-tool");
  const embedded = isEmbeddedMode();
  const effectiveCallGateway = embedded
    ? createEmbeddedCallGateway()
    : openClawToolsDeps.callGateway;
  const tools: AnyAgentTool[] = [
    ...(embedded
      ? []
      : [
          createCanvasTool({ config: options?.config }),
          nodesTool,
          createCronTool({
            agentSessionKey: options?.agentSessionKey,
            currentDeliveryContext: {
              channel: options?.agentChannel,
              to: options?.currentChannelId ?? options?.agentTo,
              accountId: options?.agentAccountId,
              threadId: options?.currentThreadTs ?? options?.agentThreadId,
            },
            ...(options?.cronSelfRemoveOnlyJobId
              ? { selfRemoveOnlyJobId: options.cronSelfRemoveOnlyJobId }
              : {}),
          }),
        ]),
    ...(!embedded && messageTool ? [messageTool] : []),
    ...collectPresentOpenClawTools([heartbeatTool]),
    createTtsTool({
      agentChannel: options?.agentChannel,
      config: resolvedConfig,
      agentId: sessionAgentId,
      agentAccountId: options?.agentAccountId,
    }),
    ...collectPresentOpenClawTools([imageGenerateTool, musicGenerateTool, videoGenerateTool]),
    ...(embedded
      ? []
      : [
          createGatewayTool({
            agentSessionKey: options?.agentSessionKey,
            config: options?.config,
          }),
        ]),
    createAgentsListTool({
      agentSessionKey: options?.agentSessionKey,
      requesterAgentIdOverride: options?.requesterAgentIdOverride,
    }),
    ...(isUpdatePlanToolEnabledForOpenClawTools({
      config: resolvedConfig,
      agentSessionKey: options?.agentSessionKey,
      agentId: options?.requesterAgentIdOverride,
      modelProvider: options?.modelProvider,
      modelId: options?.modelId,
    })
      ? [createUpdatePlanTool()]
      : []),
    createSessionsListTool({
      agentSessionKey: options?.agentSessionKey,
      sandboxed: options?.sandboxed,
      config: resolvedConfig,
      callGateway: effectiveCallGateway,
    }),
    createSessionsHistoryTool({
      agentSessionKey: options?.agentSessionKey,
      sandboxed: options?.sandboxed,
      config: resolvedConfig,
      callGateway: effectiveCallGateway,
    }),
    ...(embedded
      ? []
      : [
          createSessionsSendTool({
            agentSessionKey: options?.agentSessionKey,
            agentChannel: options?.agentChannel,
            sandboxed: options?.sandboxed,
            config: resolvedConfig,
            callGateway: openClawToolsDeps.callGateway,
          }),
          createSessionsSpawnTool({
            agentSessionKey: options?.agentSessionKey,
            agentChannel: options?.agentChannel,
            agentAccountId: options?.agentAccountId,
            agentTo: options?.agentTo,
            agentThreadId: options?.agentThreadId,
            agentGroupId: options?.agentGroupId,
            agentGroupChannel: options?.agentGroupChannel,
            agentGroupSpace: options?.agentGroupSpace,
            agentMemberRoleIds: options?.agentMemberRoleIds,
            sandboxed: options?.sandboxed,
            config: resolvedConfig,
            requesterAgentIdOverride: options?.requesterAgentIdOverride,
            workspaceDir: spawnWorkspaceDir,
          }),
        ]),
    createSessionsYieldTool({
      sessionId: options?.sessionId,
      onYield: options?.onYield,
    }),
    createSubagentsTool({
      agentSessionKey: options?.agentSessionKey,
    }),
    createSessionStatusTool({
      agentSessionKey: options?.agentSessionKey,
      config: resolvedConfig,
      sandboxed: options?.sandboxed,
    }),
    ...collectPresentOpenClawTools([webSearchTool, webFetchTool, imageTool, pdfTool]),
  ];
  options?.recordToolPrepStage?.("openclaw-tools:core-tool-list");

  if (options?.disablePluginTools) {
    return tools;
  }

  const wrappedPluginTools = resolveOpenClawPluginToolsForOptions({
    options,
    resolvedConfig,
    existingToolNames: new Set(tools.map((tool) => tool.name)),
  });
  options?.recordToolPrepStage?.("openclaw-tools:plugin-tools");

  return [...tools, ...wrappedPluginTools];
}

export const __testing = {
  resolveOptionalMediaToolFactoryPlan,
  setDepsForTest(overrides?: Partial<OpenClawToolsDeps>) {
    openClawToolsDeps = overrides
      ? {
          ...defaultOpenClawToolsDeps,
          ...overrides,
        }
      : defaultOpenClawToolsDeps;
  },
};
