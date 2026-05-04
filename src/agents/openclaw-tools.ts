import { selectApplicableRuntimeConfig } from "../config/config.js";
import type { AgentModelConfig } from "../config/types.agents-shared.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGateway } from "../gateway/call.js";
import { isEmbeddedMode } from "../infra/embedded-mode.js";
import { loadManifestMetadataSnapshot } from "../plugins/manifest-contract-eligibility.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import {
  getActiveRuntimeWebToolsMetadata,
  getActiveSecretsRuntimeSnapshot,
} from "../secrets/runtime.js";
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
import type { PreparedOpenClawToolPlanning } from "./runtime-plan/types.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";
import type { SpawnedToolContext } from "./spawned-context.js";
import type { ToolFsPolicy } from "./tool-fs-policy.js";
import { createToolPolicyMatcher } from "./tool-policy-match.js";
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
import {
  hasSnapshotCapabilityAvailability,
  hasSnapshotProviderEnvAvailability,
  type CapabilityContractKey,
} from "./tools/manifest-capability-availability.js";
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

type OptionalMediaToolFactoryPlan = {
  imageGenerate: boolean;
  videoGenerate: boolean;
  musicGenerate: boolean;
  pdf: boolean;
};
type CapabilityMetadataSnapshot = Pick<PluginMetadataSnapshot, "index" | "plugins">;
type CapabilityMetadataSnapshotLoader = () => CapabilityMetadataSnapshot;

function mergeFactoryPolicyList(base?: string[], extra?: string[]): string[] | undefined {
  const merged = [...(base ?? []), ...(extra ?? [])].filter(Boolean);
  return merged.length > 0 ? merged : undefined;
}

function hasExplicitToolModelConfig(modelConfig: AgentModelConfig | undefined): boolean {
  return hasToolModelConfig(coerceToolModelConfig(modelConfig));
}

function hasExplicitImageModelConfig(config: OpenClawConfig | undefined): boolean {
  return hasToolModelConfig(coerceImageModelConfig(config));
}
function resolveImageToolFactoryAvailable(params: {
  config?: OpenClawConfig;
  agentDir?: string;
  modelHasVision?: boolean;
  authStore?: AuthProfileStore;
  workspaceDir?: string;
  loadCapabilitySnapshot?: CapabilityMetadataSnapshotLoader;
}): boolean {
  if (!params.agentDir?.trim()) {
    return false;
  }
  if (params.modelHasVision || hasExplicitImageModelConfig(params.config)) {
    return true;
  }
  const snapshot =
    params.loadCapabilitySnapshot?.() ??
    loadManifestMetadataSnapshot({
      config: params.config,
      ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    });
  return (
    hasSnapshotCapabilityAvailability({
      snapshot,
      authStore: params.authStore,
      key: "mediaUnderstandingProviders",
      config: params.config,
    }) ||
    hasConfiguredVisionModelAuthSignal({
      config: params.config,
      snapshot,
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

function resolveOptionalMediaToolFactoryPlan(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  authStore?: AuthProfileStore;
  coreToolAllowlist?: string[];
  toolAllowlist?: string[];
  toolDenylist?: string[];
  loadCapabilitySnapshot?: CapabilityMetadataSnapshotLoader;
}): OptionalMediaToolFactoryPlan {
  const defaults = params.config?.agents?.defaults;
  const mergedCoreToolAllowlist = mergeFactoryPolicyList(
    params.config?.tools?.allow,
    params.coreToolAllowlist,
  );
  const mergedToolAllowlist = mergeFactoryPolicyList(
    params.config?.tools?.allow,
    params.toolAllowlist,
  );
  const mergedToolDenylist = mergeFactoryPolicyList(
    params.config?.tools?.deny,
    params.toolDenylist,
  );
  const coreToolAllowed = createToolPolicyMatcher(
    mergedCoreToolAllowlist || mergedToolDenylist
      ? {
          allow: mergedCoreToolAllowlist,
          deny: mergedToolDenylist,
        }
      : undefined,
  );
  const pluginToolAllowed = createToolPolicyMatcher({
    allow: mergedToolAllowlist,
    deny: mergedToolDenylist,
  });
  const isOptionalMediaToolAllowed = (toolName: string) =>
    coreToolAllowed(toolName) && pluginToolAllowed(toolName);
  const allowImageGenerate = isOptionalMediaToolAllowed("image_generate");
  const allowVideoGenerate = isOptionalMediaToolAllowed("video_generate");
  const allowMusicGenerate = isOptionalMediaToolAllowed("music_generate");
  const allowPdf = isOptionalMediaToolAllowed("pdf");
  const explicitImageGeneration = hasExplicitToolModelConfig(defaults?.imageGenerationModel);
  const explicitVideoGeneration = hasExplicitToolModelConfig(defaults?.videoGenerationModel);
  const explicitMusicGeneration = hasExplicitToolModelConfig(defaults?.musicGenerationModel);
  const explicitPdf =
    hasToolModelConfig(coercePdfModelConfig(params.config)) ||
    hasToolModelConfig(coerceImageModelConfig(params.config));
  if (params.config?.plugins?.enabled === false) {
    return {
      imageGenerate: false,
      videoGenerate: false,
      musicGenerate: false,
      pdf: false,
    };
  }
  const needsSnapshot =
    (allowImageGenerate && !explicitImageGeneration) ||
    (allowVideoGenerate && !explicitVideoGeneration) ||
    (allowMusicGenerate && !explicitMusicGeneration) ||
    (allowPdf && !explicitPdf);
  const snapshot =
    needsSnapshot &&
    (params.loadCapabilitySnapshot?.() ??
      loadManifestMetadataSnapshot({
        config: params.config,
        ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
      }));
  const hasCapability = (key: CapabilityContractKey) =>
    !!snapshot &&
    hasSnapshotCapabilityAvailability({
      snapshot,
      authStore: params.authStore,
      key,
      config: params.config,
    });
  return {
    imageGenerate:
      allowImageGenerate && (explicitImageGeneration || hasCapability("imageGenerationProviders")),
    videoGenerate:
      allowVideoGenerate && (explicitVideoGeneration || hasCapability("videoGenerationProviders")),
    musicGenerate:
      allowMusicGenerate && (explicitMusicGeneration || hasCapability("musicGenerationProviders")),
    pdf:
      allowPdf &&
      (explicitPdf ||
        hasCapability("mediaUnderstandingProviders") ||
        (!!snapshot &&
          hasConfiguredVisionModelAuthSignal({
            config: params.config,
            snapshot,
            authStore: params.authStore,
          }))),
  };
}

function createCoreToolMaterializer(coreToolAllowlist?: string[]) {
  const coreToolAllowPolicy =
    coreToolAllowlist && coreToolAllowlist.length > 0 ? { allow: coreToolAllowlist } : undefined;
  const isCoreToolAllowed = createToolPolicyMatcher(coreToolAllowPolicy);
  const selectedTools = new Map<string, boolean>();
  const isSelected = (name: string) => {
    const cached = selectedTools.get(name);
    if (cached !== undefined) {
      return cached;
    }
    const selected = isCoreToolAllowed(name);
    selectedTools.set(name, selected);
    return selected;
  };

  const optional = <Tool extends AnyAgentTool>(
    name: string,
    createTool: () => Tool | null | undefined,
  ): Tool | null => (isSelected(name) ? (createTool() ?? null) : null);

  return {
    optional,
    list<Tool extends AnyAgentTool>(
      name: string,
      createTool: () => Tool | null | undefined,
    ): Tool[] {
      const tool = optional(name, createTool);
      return tool ? [tool] : [];
    },
  };
}

export function createOpenClawTools(
  options?: {
    sandboxBrowserBridgeUrl?: string;
    allowHostBrowserControl?: boolean;
    agentSessionKey?: string;
    /**
     * The actual live run session key. When the tool is constructed with a sandbox/policy
     * session key, this allows `session_status({sessionKey:"current"})` to resolve to
     * the live run session instead of the stale sandbox key.
     */
    runSessionKey?: string;
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
    /** Explicit core tool allowlist already resolved by the caller's runtime policy. */
    coreToolAllowlist?: string[];
    pluginToolAllowlist?: string[];
    pluginToolDenylist?: string[];
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
    /** Prepared request-scoped plugin metadata for tool planning. */
    preparedToolPlanning?: PreparedOpenClawToolPlanning;
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
  const runtimeSnapshot = getActiveSecretsRuntimeSnapshot();
  const availabilityConfig = selectApplicableRuntimeConfig({
    inputConfig: resolvedConfig,
    runtimeConfig: runtimeSnapshot?.config,
    runtimeSourceConfig: runtimeSnapshot?.sourceConfig,
  });
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
  const coreTools = createCoreToolMaterializer(options?.coreToolAllowlist);
  let runtimeWebTools: ReturnType<typeof getActiveRuntimeWebToolsMetadata> | undefined;
  const resolveRuntimeWebTools = () => {
    if (runtimeWebTools === undefined) {
      runtimeWebTools = getActiveRuntimeWebToolsMetadata();
    }
    return runtimeWebTools;
  };
  const sandbox =
    options?.sandboxRoot && options?.sandboxFsBridge
      ? { root: options.sandboxRoot, bridge: options.sandboxFsBridge }
      : undefined;
  let mediaCapabilitySnapshot: CapabilityMetadataSnapshot | undefined;
  let toolPlanningMetadataSnapshot = options?.preparedToolPlanning?.metadataSnapshot;
  const loadToolPlanningMetadataSnapshot = () => {
    toolPlanningMetadataSnapshot ??=
      options?.preparedToolPlanning?.loadMetadataSnapshot?.() ??
      loadManifestMetadataSnapshot({
        config: resolvedConfig,
        ...(workspaceDir ? { workspaceDir } : {}),
      });
    return toolPlanningMetadataSnapshot;
  };
  const loadMediaCapabilitySnapshot = () => {
    const mediaConfig = availabilityConfig ?? resolvedConfig;
    if (mediaConfig === resolvedConfig) {
      mediaCapabilitySnapshot ??= loadToolPlanningMetadataSnapshot();
      return mediaCapabilitySnapshot;
    }
    mediaCapabilitySnapshot ??= loadManifestMetadataSnapshot({
      config: mediaConfig,
      ...(workspaceDir ? { workspaceDir } : {}),
    });
    return mediaCapabilitySnapshot;
  };
  const optionalMediaTools = resolveOptionalMediaToolFactoryPlan({
    config: availabilityConfig ?? resolvedConfig,
    workspaceDir,
    authStore: options?.authProfileStore,
    coreToolAllowlist: options?.coreToolAllowlist,
    toolAllowlist: options?.pluginToolAllowlist,
    toolDenylist: options?.pluginToolDenylist,
    loadCapabilitySnapshot: loadMediaCapabilitySnapshot,
  });
  const imageToolAgentDir = options?.agentDir;
  const imageTool = coreTools.optional("image", () =>
    resolveImageToolFactoryAvailable({
      config: availabilityConfig ?? resolvedConfig,
      agentDir: imageToolAgentDir,
      modelHasVision: options?.modelHasVision,
      authStore: options?.authProfileStore,
      workspaceDir,
      loadCapabilitySnapshot: loadMediaCapabilitySnapshot,
    })
      ? createImageTool({
          config: availabilityConfig ?? options?.config,
          agentDir: imageToolAgentDir!,
          authProfileStore: options?.authProfileStore,
          workspaceDir,
          sandbox,
          fsPolicy: options?.fsPolicy,
          modelHasVision: options?.modelHasVision,
          deferAutoModelResolution: true,
        })
      : null,
  );
  options?.recordToolPrepStage?.("openclaw-tools:image-tool");
  const imageGenerateTool = coreTools.optional("image_generate", () =>
    optionalMediaTools.imageGenerate
      ? createImageGenerateTool({
          config: options?.config,
          agentDir: options?.agentDir,
          authProfileStore: options?.authProfileStore,
          workspaceDir,
          sandbox,
          fsPolicy: options?.fsPolicy,
          precomputedAvailability: optionalMediaTools.imageGenerate,
        })
      : null,
  );
  options?.recordToolPrepStage?.("openclaw-tools:image-generate-tool");
  const videoGenerateTool = coreTools.optional("video_generate", () =>
    optionalMediaTools.videoGenerate
      ? createVideoGenerateTool({
          config: options?.config,
          agentDir: options?.agentDir,
          authProfileStore: options?.authProfileStore,
          agentSessionKey: options?.agentSessionKey,
          requesterOrigin: deliveryContext ?? undefined,
          workspaceDir,
          sandbox,
          fsPolicy: options?.fsPolicy,
          precomputedAvailability: optionalMediaTools.videoGenerate,
        })
      : null,
  );
  options?.recordToolPrepStage?.("openclaw-tools:video-generate-tool");
  const musicGenerateTool = coreTools.optional("music_generate", () =>
    optionalMediaTools.musicGenerate
      ? createMusicGenerateTool({
          config: options?.config,
          agentDir: options?.agentDir,
          authProfileStore: options?.authProfileStore,
          agentSessionKey: options?.agentSessionKey,
          requesterOrigin: deliveryContext ?? undefined,
          workspaceDir,
          sandbox,
          fsPolicy: options?.fsPolicy,
          precomputedAvailability: optionalMediaTools.musicGenerate,
        })
      : null,
  );
  options?.recordToolPrepStage?.("openclaw-tools:music-generate-tool");
  const pdfTool = coreTools.optional("pdf", () =>
    optionalMediaTools.pdf && options?.agentDir?.trim()
      ? createPdfTool({
          config: options?.config,
          agentDir: options.agentDir,
          authProfileStore: options?.authProfileStore,
          workspaceDir,
          sandbox,
          fsPolicy: options?.fsPolicy,
          deferAutoModelResolution: true,
        })
      : null,
  );
  options?.recordToolPrepStage?.("openclaw-tools:pdf-tool");
  const webSearchTool = coreTools.optional("web_search", () => {
    const metadata = resolveRuntimeWebTools();
    return createWebSearchTool({
      config: options?.config,
      sandboxed: options?.sandboxed,
      runtimeWebSearch: metadata?.search,
      lateBindRuntimeConfig: true,
    });
  });
  options?.recordToolPrepStage?.("openclaw-tools:web-search-tool");
  const webFetchTool = coreTools.optional("web_fetch", () => {
    const metadata = resolveRuntimeWebTools();
    return createWebFetchTool({
      config: options?.config,
      sandboxed: options?.sandboxed,
      runtimeWebFetch: metadata?.fetch,
      lateBindRuntimeConfig: true,
    });
  });
  options?.recordToolPrepStage?.("openclaw-tools:web-fetch-tool");
  const messageTool = coreTools.optional("message", () =>
    options?.disableMessageTool
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
        }),
  );
  options?.recordToolPrepStage?.("openclaw-tools:message-tool");
  const heartbeatTool = coreTools.optional("heartbeat_respond", () =>
    options?.enableHeartbeatTool ? createHeartbeatResponseTool() : null,
  );
  const nodesTool = coreTools.optional("nodes", () =>
    applyNodesToolWorkspaceGuard(
      createNodesTool({
        agentSessionKey: options?.agentSessionKey,
        agentChannel: options?.agentChannel,
        agentAccountId: options?.agentAccountId,
        currentChannelId: options?.currentChannelId,
        currentThreadTs: options?.currentThreadTs,
        config: options?.config,
        modelHasVision: options?.modelHasVision,
        allowMediaInvokeCommands: options?.allowMediaInvokeCommands,
      }),
      {
        fsPolicy: options?.fsPolicy,
        sandboxContainerWorkdir: options?.sandboxContainerWorkdir,
        sandboxRoot: options?.sandboxRoot,
        workspaceDir,
      },
    ),
  );
  options?.recordToolPrepStage?.("openclaw-tools:nodes-tool");
  const embedded = isEmbeddedMode();
  const effectiveCallGateway = embedded
    ? createEmbeddedCallGateway()
    : openClawToolsDeps.callGateway;
  const tools: AnyAgentTool[] = [
    ...(embedded
      ? []
      : [
          ...coreTools.list("canvas", () => createCanvasTool({ config: options?.config })),
          ...collectPresentOpenClawTools([nodesTool]),
          ...coreTools.list("cron", () =>
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
          ),
        ]),
    ...(!embedded && messageTool ? [messageTool] : []),
    ...collectPresentOpenClawTools([heartbeatTool]),
    ...coreTools.list("tts", () =>
      createTtsTool({
        agentChannel: options?.agentChannel,
        config: resolvedConfig,
        agentId: sessionAgentId,
        agentAccountId: options?.agentAccountId,
      }),
    ),
    ...collectPresentOpenClawTools([imageGenerateTool, musicGenerateTool, videoGenerateTool]),
    ...(embedded
      ? []
      : [
          ...coreTools.list("gateway", () =>
            createGatewayTool({
              agentSessionKey: options?.agentSessionKey,
              config: options?.config,
            }),
          ),
        ]),
    ...coreTools.list("agents_list", () =>
      createAgentsListTool({
        agentSessionKey: options?.agentSessionKey,
        requesterAgentIdOverride: options?.requesterAgentIdOverride,
      }),
    ),
    ...coreTools.list("update_plan", () =>
      isUpdatePlanToolEnabledForOpenClawTools({
        config: resolvedConfig,
        agentSessionKey: options?.agentSessionKey,
        agentId: options?.requesterAgentIdOverride,
        modelProvider: options?.modelProvider,
        modelId: options?.modelId,
      })
        ? createUpdatePlanTool()
        : null,
    ),
    ...coreTools.list("sessions_list", () =>
      createSessionsListTool({
        agentSessionKey: options?.agentSessionKey,
        sandboxed: options?.sandboxed,
        config: resolvedConfig,
        callGateway: effectiveCallGateway,
      }),
    ),
    ...coreTools.list("sessions_history", () =>
      createSessionsHistoryTool({
        agentSessionKey: options?.agentSessionKey,
        sandboxed: options?.sandboxed,
        config: resolvedConfig,
        callGateway: effectiveCallGateway,
      }),
    ),
    ...(embedded
      ? []
      : [
          ...coreTools.list("sessions_send", () =>
            createSessionsSendTool({
              agentSessionKey: options?.agentSessionKey,
              agentChannel: options?.agentChannel,
              sandboxed: options?.sandboxed,
              config: resolvedConfig,
              callGateway: openClawToolsDeps.callGateway,
            }),
          ),
          ...coreTools.list("sessions_spawn", () =>
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
          ),
        ]),
    ...coreTools.list("sessions_yield", () =>
      createSessionsYieldTool({
        sessionId: options?.sessionId,
        onYield: options?.onYield,
      }),
    ),
    ...coreTools.list("subagents", () =>
      createSubagentsTool({
        agentSessionKey: options?.agentSessionKey,
      }),
    ),
    ...coreTools.list("session_status", () =>
      createSessionStatusTool({
        agentSessionKey: options?.agentSessionKey,
        runSessionKey: options?.runSessionKey,
        config: resolvedConfig,
        sandboxed: options?.sandboxed,
      }),
    ),
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
    ...(toolPlanningMetadataSnapshot ? { metadataSnapshot: toolPlanningMetadataSnapshot } : {}),
    loadMetadataSnapshot: loadToolPlanningMetadataSnapshot,
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
