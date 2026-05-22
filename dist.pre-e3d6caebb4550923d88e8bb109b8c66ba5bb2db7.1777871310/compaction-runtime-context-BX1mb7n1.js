//#region src/agents/pi-embedded-runner/compaction-runtime-context.ts
/**
* Resolve the effective compaction target from config, falling back to the
* caller-supplied provider/model and optionally applying runtime defaults.
*/
function resolveEmbeddedCompactionTarget(params) {
	const provider = params.provider?.trim() || params.defaultProvider;
	const model = params.modelId?.trim() || params.defaultModel;
	const override = params.config?.agents?.defaults?.compaction?.model?.trim();
	if (!override) return {
		provider,
		model,
		authProfileId: params.authProfileId ?? void 0
	};
	const slashIdx = override.indexOf("/");
	if (slashIdx > 0) {
		const overrideProvider = override.slice(0, slashIdx).trim();
		return {
			provider: overrideProvider,
			model: override.slice(slashIdx + 1).trim() || params.defaultModel,
			authProfileId: overrideProvider !== (params.provider ?? "")?.trim() ? void 0 : params.authProfileId ?? void 0
		};
	}
	return {
		provider,
		model: override,
		authProfileId: params.authProfileId ?? void 0
	};
}
function buildEmbeddedCompactionRuntimeContext(params) {
	const resolved = resolveEmbeddedCompactionTarget({
		config: params.config,
		provider: params.provider,
		modelId: params.modelId,
		authProfileId: params.authProfileId
	});
	return {
		sessionKey: params.sessionKey ?? void 0,
		messageChannel: params.messageChannel ?? void 0,
		messageProvider: params.messageProvider ?? void 0,
		agentAccountId: params.agentAccountId ?? void 0,
		currentChannelId: params.currentChannelId ?? void 0,
		currentThreadTs: params.currentThreadTs ?? void 0,
		currentMessageId: params.currentMessageId ?? void 0,
		authProfileId: resolved.authProfileId,
		workspaceDir: params.workspaceDir,
		agentDir: params.agentDir,
		config: params.config,
		skillsSnapshot: params.skillsSnapshot,
		senderIsOwner: params.senderIsOwner,
		senderId: params.senderId ?? void 0,
		provider: resolved.provider,
		model: resolved.model,
		modelFallbacksOverride: params.modelFallbacksOverride,
		thinkLevel: params.thinkLevel,
		reasoningLevel: params.reasoningLevel,
		bashElevated: params.bashElevated,
		extraSystemPrompt: params.extraSystemPrompt,
		sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
		ownerNumbers: params.ownerNumbers
	};
}
//#endregion
export { resolveEmbeddedCompactionTarget as n, buildEmbeddedCompactionRuntimeContext as t };
