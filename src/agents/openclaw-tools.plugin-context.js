import { normalizeDeliveryContext } from "../utils/delivery-context.js";
import { resolveAgentWorkspaceDir, resolveSessionAgentId } from "./agent-scope.js";
import { resolveWorkspaceRoot } from "./workspace-dir.js";
export function resolveOpenClawPluginToolInputs(params) {
    const { options, resolvedConfig, runtimeConfig } = params;
    const sessionAgentId = resolveSessionAgentId({
        sessionKey: options?.agentSessionKey,
        config: resolvedConfig,
    });
    const inferredWorkspaceDir = options?.workspaceDir || !resolvedConfig
        ? undefined
        : resolveAgentWorkspaceDir(resolvedConfig, sessionAgentId);
    const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir ?? inferredWorkspaceDir);
    const deliveryContext = normalizeDeliveryContext({
        channel: options?.agentChannel,
        to: options?.agentTo,
        accountId: options?.agentAccountId,
        threadId: options?.agentThreadId,
    });
    return {
        context: {
            config: options?.config,
            runtimeConfig,
            fsPolicy: options?.fsPolicy,
            workspaceDir,
            agentDir: options?.agentDir,
            agentId: sessionAgentId,
            sessionKey: options?.agentSessionKey,
            sessionId: options?.sessionId,
            browser: {
                sandboxBridgeUrl: options?.sandboxBrowserBridgeUrl,
                allowHostControl: options?.allowHostBrowserControl,
            },
            messageChannel: options?.agentChannel,
            agentAccountId: options?.agentAccountId,
            deliveryContext,
            requesterSenderId: options?.requesterSenderId ?? undefined,
            senderIsOwner: options?.senderIsOwner ?? undefined,
            sandboxed: options?.sandboxed,
        },
        allowGatewaySubagentBinding: options?.allowGatewaySubagentBinding,
    };
}
