import { resolvePluginTools } from "../plugins/tools.js";
import { resolveSessionAgentId } from "./agent-scope.js";
import { createAgentsListTool } from "./tools/agents-list-tool.js";
import { createBrowserTool } from "./tools/browser-tool.js";
import { createCanvasTool } from "./tools/canvas-tool.js";
import { createCronTool } from "./tools/cron-tool.js";
import { createGatewayTool } from "./tools/gateway-tool.js";
import { createImageTool } from "./tools/image-tool.js";
import { createMessageTool } from "./tools/message-tool.js";
import { createNodesTool } from "./tools/nodes-tool.js";
import { createPdfTool } from "./tools/pdf-tool.js";
import { createSessionStatusTool } from "./tools/session-status-tool.js";
import { createSessionsHistoryTool } from "./tools/sessions-history-tool.js";
import { createSessionsListTool } from "./tools/sessions-list-tool.js";
import { createSessionsSendTool } from "./tools/sessions-send-tool.js";
import { createSessionsSpawnTool } from "./tools/sessions-spawn-tool.js";
import { createSubagentsTool } from "./tools/subagents-tool.js";
import { createTtsTool } from "./tools/tts-tool.js";
import { createWebFetchTool, createWebSearchTool } from "./tools/web-tools.js";
import { resolveWorkspaceRoot } from "./workspace-dir.js";
export function createOpenClawTools(options) {
    const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir);
    const imageTool = options?.agentDir?.trim()
        ? createImageTool({
            config: options?.config,
            agentDir: options.agentDir,
            workspaceDir,
            sandbox: options?.sandboxRoot && options?.sandboxFsBridge
                ? { root: options.sandboxRoot, bridge: options.sandboxFsBridge }
                : undefined,
            fsPolicy: options?.fsPolicy,
            modelHasVision: options?.modelHasVision,
        })
        : null;
    const pdfTool = options?.agentDir?.trim()
        ? createPdfTool({
            config: options?.config,
            agentDir: options.agentDir,
            workspaceDir,
            sandbox: options?.sandboxRoot && options?.sandboxFsBridge
                ? { root: options.sandboxRoot, bridge: options.sandboxFsBridge }
                : undefined,
            fsPolicy: options?.fsPolicy,
        })
        : null;
    const webSearchTool = createWebSearchTool({
        config: options?.config,
        sandboxed: options?.sandboxed,
    });
    const webFetchTool = createWebFetchTool({
        config: options?.config,
        sandboxed: options?.sandboxed,
    });
    const messageTool = options?.disableMessageTool
        ? null
        : createMessageTool({
            agentAccountId: options?.agentAccountId,
            agentSessionKey: options?.agentSessionKey,
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
        });
    const tools = [
        createBrowserTool({
            sandboxBridgeUrl: options?.sandboxBrowserBridgeUrl,
            allowHostControl: options?.allowHostBrowserControl,
        }),
        createCanvasTool({ config: options?.config }),
        createNodesTool({
            agentSessionKey: options?.agentSessionKey,
            agentChannel: options?.agentChannel,
            agentAccountId: options?.agentAccountId,
            currentChannelId: options?.currentChannelId,
            currentThreadTs: options?.currentThreadTs,
            config: options?.config,
        }),
        createCronTool({
            agentSessionKey: options?.agentSessionKey,
        }),
        ...(messageTool ? [messageTool] : []),
        createTtsTool({
            agentChannel: options?.agentChannel,
            config: options?.config,
        }),
        createGatewayTool({
            agentSessionKey: options?.agentSessionKey,
            config: options?.config,
        }),
        createAgentsListTool({
            agentSessionKey: options?.agentSessionKey,
            requesterAgentIdOverride: options?.requesterAgentIdOverride,
        }),
        createSessionsListTool({
            agentSessionKey: options?.agentSessionKey,
            sandboxed: options?.sandboxed,
        }),
        createSessionsHistoryTool({
            agentSessionKey: options?.agentSessionKey,
            sandboxed: options?.sandboxed,
        }),
        createSessionsSendTool({
            agentSessionKey: options?.agentSessionKey,
            agentChannel: options?.agentChannel,
            sandboxed: options?.sandboxed,
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
            sandboxed: options?.sandboxed,
            requesterAgentIdOverride: options?.requesterAgentIdOverride,
        }),
        createSubagentsTool({
            agentSessionKey: options?.agentSessionKey,
        }),
        createSessionStatusTool({
            agentSessionKey: options?.agentSessionKey,
            config: options?.config,
        }),
        ...(webSearchTool ? [webSearchTool] : []),
        ...(webFetchTool ? [webFetchTool] : []),
        ...(imageTool ? [imageTool] : []),
        ...(pdfTool ? [pdfTool] : []),
    ];
    const pluginTools = resolvePluginTools({
        context: {
            config: options?.config,
            workspaceDir,
            agentDir: options?.agentDir,
            agentId: resolveSessionAgentId({
                sessionKey: options?.agentSessionKey,
                config: options?.config,
            }),
            sessionKey: options?.agentSessionKey,
            messageChannel: options?.agentChannel,
            agentAccountId: options?.agentAccountId,
            requesterSenderId: options?.requesterSenderId ?? undefined,
            senderIsOwner: options?.senderIsOwner ?? undefined,
            sandboxed: options?.sandboxed,
        },
        existingToolNames: new Set(tools.map((tool) => tool.name)),
        toolAllowlist: options?.pluginToolAllowlist,
    });
    return [...tools, ...pluginTools];
}
