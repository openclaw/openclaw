export function buildEmbeddedMessageActionDiscoveryInput(params) {
    return {
        cfg: params.cfg,
        channel: params.channel,
        currentChannelId: params.currentChannelId ?? undefined,
        currentThreadTs: params.currentThreadTs ?? undefined,
        currentMessageId: params.currentMessageId ?? undefined,
        accountId: params.accountId ?? undefined,
        sessionKey: params.sessionKey ?? undefined,
        sessionId: params.sessionId ?? undefined,
        agentId: params.agentId ?? undefined,
        requesterSenderId: params.senderId ?? undefined,
        senderIsOwner: params.senderIsOwner,
    };
}
