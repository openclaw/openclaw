import { callGateway } from "../gateway/call.js";
import { isEmbeddedMode } from "../infra/embedded-mode.js";
import { getActiveRuntimeWebToolsMetadata } from "../secrets/runtime.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.js";
import { resolveAgentWorkspaceDir, resolveSessionAgentIds } from "./agent-scope.js";
import { resolveOpenClawPluginToolsForOptions } from "./openclaw-plugin-tools.js";
import { applyNodesToolWorkspaceGuard } from "./openclaw-tools.nodes-workspace-guard.js";
import { collectPresentOpenClawTools, isUpdatePlanToolEnabledForOpenClawTools, } from "./openclaw-tools.registration.js";
import { createAgentsListTool } from "./tools/agents-list-tool.js";
import { createCanvasTool } from "./tools/canvas-tool.js";
import { createCronTool } from "./tools/cron-tool.js";
import { createEmbeddedCallGateway } from "./tools/embedded-gateway-stub.js";
import { createGatewayTool } from "./tools/gateway-tool.js";
import { createImageGenerateTool } from "./tools/image-generate-tool.js";
import { createImageTool } from "./tools/image-tool.js";
import { createMessageTool } from "./tools/message-tool.js";
import { createMusicGenerateTool } from "./tools/music-generate-tool.js";
import { createNodesTool } from "./tools/nodes-tool.js";
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
const defaultOpenClawToolsDeps = {
    callGateway,
};
let openClawToolsDeps = defaultOpenClawToolsDeps;
export function createOpenClawTools(options) {
    const resolvedConfig = options?.config ?? openClawToolsDeps.config;
    const { sessionAgentId } = resolveSessionAgentIds({
        sessionKey: options?.agentSessionKey,
        config: resolvedConfig,
        agentId: options?.requesterAgentIdOverride,
    });
    // Fall back to the session agent workspace so plugin loading stays workspace-stable
    // even when a caller forgets to thread workspaceDir explicitly.
    const inferredWorkspaceDir = options?.workspaceDir || !resolvedConfig
        ? undefined
        : resolveAgentWorkspaceDir(resolvedConfig, sessionAgentId);
    const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir ?? inferredWorkspaceDir);
    const spawnWorkspaceDir = resolveWorkspaceRoot(options?.spawnWorkspaceDir ?? options?.workspaceDir ?? inferredWorkspaceDir);
    const deliveryContext = normalizeDeliveryContext({
        channel: options?.agentChannel,
        to: options?.agentTo,
        accountId: options?.agentAccountId,
        threadId: options?.agentThreadId,
    });
    const runtimeWebTools = getActiveRuntimeWebToolsMetadata();
    const sandbox = options?.sandboxRoot && options?.sandboxFsBridge
        ? { root: options.sandboxRoot, bridge: options.sandboxFsBridge }
        : undefined;
    const imageTool = options?.agentDir?.trim()
        ? createImageTool({
            config: options?.config,
            agentDir: options.agentDir,
            workspaceDir,
            sandbox,
            fsPolicy: options?.fsPolicy,
            modelHasVision: options?.modelHasVision,
        })
        : null;
    const imageGenerateTool = createImageGenerateTool({
        config: options?.config,
        agentDir: options?.agentDir,
        workspaceDir,
        sandbox,
        fsPolicy: options?.fsPolicy,
    });
    const videoGenerateTool = createVideoGenerateTool({
        config: options?.config,
        agentDir: options?.agentDir,
        agentSessionKey: options?.agentSessionKey,
        requesterOrigin: deliveryContext ?? undefined,
        workspaceDir,
        sandbox,
        fsPolicy: options?.fsPolicy,
    });
    const musicGenerateTool = createMusicGenerateTool({
        config: options?.config,
        agentDir: options?.agentDir,
        agentSessionKey: options?.agentSessionKey,
        requesterOrigin: deliveryContext ?? undefined,
        workspaceDir,
        sandbox,
        fsPolicy: options?.fsPolicy,
    });
    const pdfTool = options?.agentDir?.trim()
        ? createPdfTool({
            config: options?.config,
            agentDir: options.agentDir,
            workspaceDir,
            sandbox,
            fsPolicy: options?.fsPolicy,
        })
        : null;
    const webSearchTool = createWebSearchTool({
        config: options?.config,
        sandboxed: options?.sandboxed,
        runtimeWebSearch: runtimeWebTools?.search,
    });
    const webFetchTool = createWebFetchTool({
        config: options?.config,
        sandboxed: options?.sandboxed,
        runtimeWebFetch: runtimeWebTools?.fetch,
    });
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
    const embedded = isEmbeddedMode();
    const effectiveCallGateway = embedded
        ? createEmbeddedCallGateway()
        : openClawToolsDeps.callGateway;
    const tools = [
        ...(embedded
            ? []
            : [
                createCanvasTool({ config: options?.config }),
                nodesTool,
                createCronTool({
                    agentSessionKey: options?.agentSessionKey,
                }),
            ]),
        ...(!embedded && messageTool ? [messageTool] : []),
        createTtsTool({
            agentChannel: options?.agentChannel,
            config: resolvedConfig,
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
    if (options?.disablePluginTools) {
        return tools;
    }
    const wrappedPluginTools = resolveOpenClawPluginToolsForOptions({
        options,
        resolvedConfig,
        existingToolNames: new Set(tools.map((tool) => tool.name)),
    });
    return [...tools, ...wrappedPluginTools];
}
export const __testing = {
    setDepsForTest(overrides) {
        openClawToolsDeps = overrides
            ? {
                ...defaultOpenClawToolsDeps,
                ...overrides,
            }
            : defaultOpenClawToolsDeps;
    },
};
