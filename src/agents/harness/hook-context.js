export function buildAgentHookContext(params) {
    return {
        runId: params.runId,
        ...(params.agentId ? { agentId: params.agentId } : {}),
        ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
        ...(params.messageProvider ? { messageProvider: params.messageProvider } : {}),
        ...(params.trigger ? { trigger: params.trigger } : {}),
        ...(params.channelId ? { channelId: params.channelId } : {}),
    };
}
