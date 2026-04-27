/**
 * Resolve the effective compaction target from config, falling back to the
 * caller-supplied provider/model and optionally applying runtime defaults.
 */
export function resolveEmbeddedCompactionTarget(params) {
    const provider = params.provider?.trim() || params.defaultProvider;
    const model = params.modelId?.trim() || params.defaultModel;
    const override = params.config?.agents?.defaults?.compaction?.model?.trim();
    if (!override) {
        return {
            provider,
            model,
            authProfileId: params.authProfileId ?? undefined,
        };
    }
    const slashIdx = override.indexOf("/");
    if (slashIdx > 0) {
        const overrideProvider = override.slice(0, slashIdx).trim();
        const overrideModel = override.slice(slashIdx + 1).trim() || params.defaultModel;
        // When switching provider via override, drop the primary auth profile to
        // avoid sending the wrong credentials.
        const authProfileId = overrideProvider !== (params.provider ?? "")?.trim()
            ? undefined
            : (params.authProfileId ?? undefined);
        return { provider: overrideProvider, model: overrideModel, authProfileId };
    }
    return {
        provider,
        model: override,
        authProfileId: params.authProfileId ?? undefined,
    };
}
export function buildEmbeddedCompactionRuntimeContext(params) {
    const resolved = resolveEmbeddedCompactionTarget({
        config: params.config,
        provider: params.provider,
        modelId: params.modelId,
        authProfileId: params.authProfileId,
    });
    return {
        sessionKey: params.sessionKey ?? undefined,
        messageChannel: params.messageChannel ?? undefined,
        messageProvider: params.messageProvider ?? undefined,
        agentAccountId: params.agentAccountId ?? undefined,
        currentChannelId: params.currentChannelId ?? undefined,
        currentThreadTs: params.currentThreadTs ?? undefined,
        currentMessageId: params.currentMessageId ?? undefined,
        authProfileId: resolved.authProfileId,
        workspaceDir: params.workspaceDir,
        agentDir: params.agentDir,
        config: params.config,
        skillsSnapshot: params.skillsSnapshot,
        senderIsOwner: params.senderIsOwner,
        senderId: params.senderId ?? undefined,
        provider: resolved.provider,
        model: resolved.model,
        thinkLevel: params.thinkLevel,
        reasoningLevel: params.reasoningLevel,
        bashElevated: params.bashElevated,
        extraSystemPrompt: params.extraSystemPrompt,
        ownerNumbers: params.ownerNumbers,
    };
}
