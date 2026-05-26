import { l as listRunningSessions } from "./bash-process-registry-Kv57lBeK.js";
import { o as deriveSessionName } from "./bash-tools.shared-CPEvSxWm.js";
//#region src/agents/bash-process-references.ts
const DEFAULT_ACTIVE_PROCESS_LIMIT = 8;
const MAX_COMMAND_LABEL_CHARS = 140;
function truncate(value, maxChars) {
	if (value.length <= maxChars) return value;
	if (maxChars <= 1) return value.slice(0, maxChars);
	return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}
function listActiveProcessSessionReferences(params) {
	const scopeKey = params.scopeKey?.trim();
	if (!scopeKey) return [];
	const now = params.now ?? Date.now();
	const limit = typeof params.limit === "number" && Number.isFinite(params.limit) && params.limit > 0 ? Math.floor(params.limit) : DEFAULT_ACTIVE_PROCESS_LIMIT;
	return listRunningSessions().filter((session) => session.backgrounded).filter((session) => session.scopeKey === scopeKey).toSorted((left, right) => right.startedAt - left.startedAt).slice(0, limit).map((session) => ({
		sessionId: session.id,
		status: "running",
		pid: session.pid ?? session.child?.pid,
		startedAt: session.startedAt,
		runtimeMs: Math.max(0, now - session.startedAt),
		cwd: session.cwd,
		command: session.command,
		name: truncate(deriveSessionName(session.command) || session.command, MAX_COMMAND_LABEL_CHARS),
		tail: session.tail,
		truncated: session.truncated
	}));
}
//#endregion
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
	const processScopeKey = params.sessionKey?.trim();
	const activeProcessSessions = params.activeProcessSessions ?? listActiveProcessSessionReferences({ scopeKey: processScopeKey });
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
		ownerNumbers: params.ownerNumbers,
		...activeProcessSessions.length > 0 ? { activeProcessSessions } : {}
	};
}
//#endregion
export { resolveEmbeddedCompactionTarget as n, listActiveProcessSessionReferences as r, buildEmbeddedCompactionRuntimeContext as t };
