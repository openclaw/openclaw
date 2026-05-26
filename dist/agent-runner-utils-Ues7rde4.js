import { c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { m as resolveEffectiveModelFallbacks } from "./agent-scope-CtLXGcWm.js";
import { g as selectApplicableRuntimeConfig, i as getRuntimeConfigSnapshot, s as getRuntimeConfigSourceSnapshot } from "./runtime-snapshot-DgdkBEdP.js";
import { r as resolveProviderIdForAuth } from "./provider-auth-aliases-4jqi6Djx.js";
import "./config-B6Oplu5W.js";
import { a as normalizeAnyChannelId, o as normalizeChannelId } from "./registry-CtWyD2pE.js";
import { t as getChannelPlugin } from "./registry-Bf5TpUad.js";
import "./plugins-DYTHbmt7.js";
import { Ct as isReasoningTagProvider } from "./selection-hR-AeOeU.js";
import { t as resolveMessageSecretScope } from "./message-secret-scope-NhV1S-c7.js";
import { t as resolveCommandSecretRefsViaGateway } from "./command-secret-gateway-BpOVXOFV.js";
import { d as getScopedChannelsCommandSecretTargets, t as getAgentRuntimeCommandSecretTargetIds } from "./command-secret-targets-UUlaHEu2.js";
import { n as resolveOriginMessageProvider, r as resolveOriginMessageTo } from "./origin-routing-BrwjqMJ_.js";
//#region src/auto-reply/reply/agent-runner-auth-profile.ts
function resolveProviderScopedAuthProfile(params) {
	const aliasParams = {
		config: params.config,
		workspaceDir: params.workspaceDir
	};
	const authProfileId = resolveProviderIdForAuth(params.provider, aliasParams) === resolveProviderIdForAuth(params.primaryProvider, aliasParams) ? params.authProfileId : void 0;
	return {
		authProfileId,
		authProfileIdSource: authProfileId ? params.authProfileIdSource : void 0
	};
}
function resolveRunAuthProfile(run, provider, params) {
	return resolveProviderScopedAuthProfile({
		provider,
		primaryProvider: run.provider,
		authProfileId: run.authProfileId,
		authProfileIdSource: run.authProfileIdSource,
		config: params?.config ?? run.config,
		workspaceDir: run.workspaceDir
	});
}
//#endregion
//#region src/auto-reply/reply/agent-runner-run-params.ts
const resolveEnforceFinalTagWithResolver = (run, provider, model = run.model, isReasoningTagProvider) => (run.skipProviderRuntimeHints ? false : void 0) ?? (run.enforceFinalTag || isReasoningTagProvider?.(provider, {
	config: run.config,
	workspaceDir: run.workspaceDir,
	modelId: model
}) || false);
function resolveModelFallbackOptions(run, configOverride = run.config) {
	const config = configOverride;
	const fallbacksOverride = run.imageModelFallbacksOverride ?? resolveEffectiveModelFallbacks({
		cfg: config,
		agentId: run.agentId,
		sessionKey: run.sessionKey,
		hasSessionModelOverride: run.hasSessionModelOverride === true,
		modelOverrideSource: run.modelOverrideSource,
		hasAutoFallbackProvenance: run.hasAutoFallbackProvenance === true
	});
	return {
		cfg: config,
		provider: run.provider,
		model: run.model,
		agentDir: run.agentDir,
		agentId: run.agentId,
		sessionKey: run.runtimePolicySessionKey ?? run.sessionKey,
		fallbacksOverride
	};
}
function buildEmbeddedRunBaseParams$1(params) {
	const config = params.run.config;
	const modelFallbacksOverride = params.run.imageModelFallbacksOverride ?? resolveEffectiveModelFallbacks({
		cfg: config,
		agentId: params.run.agentId,
		sessionKey: params.run.sessionKey,
		hasSessionModelOverride: params.run.hasSessionModelOverride === true,
		modelOverrideSource: params.run.modelOverrideSource,
		hasAutoFallbackProvenance: params.run.hasAutoFallbackProvenance === true
	});
	return {
		sessionFile: params.run.sessionFile,
		workspaceDir: params.run.workspaceDir,
		agentDir: params.run.agentDir,
		config,
		skillsSnapshot: params.run.skillsSnapshot,
		ownerNumbers: params.run.ownerNumbers,
		inputProvenance: params.run.inputProvenance,
		senderIsOwner: params.run.senderIsOwner,
		enforceFinalTag: resolveEnforceFinalTagWithResolver(params.run, params.provider, params.model, params.isReasoningTagProvider),
		silentExpected: params.run.silentExpected,
		allowEmptyAssistantReplyAsSilent: params.run.allowEmptyAssistantReplyAsSilent,
		silentReplyPromptMode: params.run.silentReplyPromptMode,
		sourceReplyDeliveryMode: params.run.sourceReplyDeliveryMode,
		provider: params.provider,
		model: params.model,
		modelFallbacksOverride,
		...params.authProfile,
		thinkLevel: params.run.thinkLevel,
		verboseLevel: params.run.verboseLevel,
		reasoningLevel: params.run.reasoningLevel,
		execOverrides: params.run.execOverrides,
		bashElevated: params.run.bashElevated,
		timeoutMs: params.run.timeoutMs,
		runId: params.runId,
		allowTransientCooldownProbe: params.allowTransientCooldownProbe
	};
}
//#endregion
//#region src/auto-reply/reply/agent-runner-utils.ts
const BUN_FETCH_SOCKET_ERROR_RE = /socket connection was closed unexpectedly/i;
function resolveQueuedReplyRuntimeConfig(config) {
	return selectApplicableRuntimeConfig({
		inputConfig: config,
		runtimeConfig: typeof getRuntimeConfigSnapshot === "function" ? getRuntimeConfigSnapshot() : null,
		runtimeSourceConfig: typeof getRuntimeConfigSourceSnapshot === "function" ? getRuntimeConfigSourceSnapshot() : null
	}) ?? config;
}
async function resolveQueuedReplyExecutionConfig(config, params) {
	const runtimeConfig = resolveQueuedReplyRuntimeConfig(config);
	const { resolvedConfig } = await resolveCommandSecretRefsViaGateway({
		config: runtimeConfig,
		commandName: "reply",
		targetIds: getAgentRuntimeCommandSecretTargetIds()
	});
	const baseResolvedConfig = resolvedConfig ?? runtimeConfig;
	const scope = resolveMessageSecretScope({
		channel: params?.originatingChannel,
		fallbackChannel: params?.messageProvider,
		accountId: params?.originatingAccountId,
		fallbackAccountId: params?.agentAccountId
	});
	if (!scope.channel) return baseResolvedConfig;
	const scopedTargets = getScopedChannelsCommandSecretTargets({
		config: baseResolvedConfig,
		channel: scope.channel,
		accountId: scope.accountId
	});
	if (scopedTargets.targetIds.size === 0) return baseResolvedConfig;
	return (await resolveCommandSecretRefsViaGateway({
		config: baseResolvedConfig,
		commandName: "reply",
		targetIds: scopedTargets.targetIds,
		...scopedTargets.allowedPaths ? { allowedPaths: scopedTargets.allowedPaths } : {}
	})).resolvedConfig ?? baseResolvedConfig;
}
/**
* Build provider-specific threading context for tool auto-injection.
*/
function buildThreadingToolContext(params) {
	const { sessionCtx, config, hasRepliedRef } = params;
	const currentMessageId = sessionCtx.MessageSidFull ?? sessionCtx.MessageSid;
	const originProvider = resolveOriginMessageProvider({
		originatingChannel: sessionCtx.OriginatingChannel,
		provider: sessionCtx.Provider
	});
	const originTo = resolveOriginMessageTo({
		originatingTo: sessionCtx.OriginatingTo,
		to: sessionCtx.To
	});
	if (!config) return { currentMessageId };
	const rawProvider = normalizeOptionalLowercaseString(originProvider);
	if (!rawProvider) return { currentMessageId };
	const provider = normalizeChannelId(rawProvider) ?? normalizeAnyChannelId(rawProvider);
	const threading = provider ? getChannelPlugin(provider)?.threading : void 0;
	if (!threading?.buildToolContext) return {
		currentChannelId: normalizeOptionalString(originTo),
		currentChannelProvider: provider ?? rawProvider,
		currentMessageId,
		hasRepliedRef
	};
	const context = threading.buildToolContext({
		cfg: config,
		accountId: sessionCtx.AccountId,
		context: {
			Channel: originProvider,
			From: sessionCtx.From,
			To: originTo,
			ChatType: sessionCtx.ChatType,
			CurrentMessageId: currentMessageId,
			ReplyToId: sessionCtx.ReplyToId,
			ThreadLabel: sessionCtx.ThreadLabel,
			MessageThreadId: sessionCtx.MessageThreadId,
			TransportThreadId: sessionCtx.TransportThreadId,
			NativeChannelId: sessionCtx.NativeChannelId
		},
		hasRepliedRef
	}) ?? {};
	return {
		...context,
		currentChannelProvider: provider,
		currentMessageId: context.currentMessageId ?? currentMessageId
	};
}
const isBunFetchSocketError = (message) => message ? BUN_FETCH_SOCKET_ERROR_RE.test(message) : false;
const formatBunFetchSocketError = (message) => {
	return [
		"⚠️ LLM connection failed. This could be due to server issues, network problems, or context length exceeded (e.g., with local LLMs like LM Studio). Original error:",
		"```",
		message.trim() || "Unknown error",
		"```"
	].join("\n");
};
function buildEmbeddedRunBaseParams(params) {
	return buildEmbeddedRunBaseParams$1({
		...params,
		isReasoningTagProvider
	});
}
function buildEmbeddedContextFromTemplate(params) {
	const config = params.run.config;
	return {
		sessionId: params.run.sessionId,
		sessionKey: params.run.sessionKey,
		sandboxSessionKey: params.run.runtimePolicySessionKey,
		agentId: params.run.agentId,
		messageProvider: resolveOriginMessageProvider({
			originatingChannel: params.sessionCtx.OriginatingChannel,
			provider: params.sessionCtx.Provider
		}),
		agentAccountId: params.sessionCtx.AccountId,
		messageTo: resolveOriginMessageTo({
			originatingTo: params.sessionCtx.OriginatingTo,
			to: params.sessionCtx.To
		}),
		messageThreadId: params.sessionCtx.MessageThreadId ?? void 0,
		memberRoleIds: normalizeMemberRoleIds(params.sessionCtx.MemberRoleIds),
		...buildThreadingToolContext({
			sessionCtx: params.sessionCtx,
			config,
			hasRepliedRef: params.hasRepliedRef
		})
	};
}
function normalizeMemberRoleIds(value) {
	const roles = Array.isArray(value) ? value.map((roleId) => normalizeOptionalString(roleId)).filter((roleId) => Boolean(roleId)) : [];
	return roles.length > 0 ? roles : void 0;
}
function buildTemplateSenderContext(sessionCtx) {
	return {
		senderId: normalizeOptionalString(sessionCtx.SenderId),
		senderName: normalizeOptionalString(sessionCtx.SenderName),
		senderUsername: normalizeOptionalString(sessionCtx.SenderUsername),
		senderE164: normalizeOptionalString(sessionCtx.SenderE164)
	};
}
function buildEmbeddedRunContexts(params) {
	return {
		authProfile: resolveRunAuthProfile(params.run, params.provider),
		embeddedContext: buildEmbeddedContextFromTemplate({
			run: params.run,
			sessionCtx: params.sessionCtx,
			hasRepliedRef: params.hasRepliedRef
		}),
		senderContext: buildTemplateSenderContext(params.sessionCtx)
	};
}
function buildEmbeddedRunExecutionParams(params) {
	const { authProfile, embeddedContext, senderContext } = buildEmbeddedRunContexts(params);
	return {
		embeddedContext,
		senderContext,
		runBaseParams: buildEmbeddedRunBaseParams({
			run: params.run,
			provider: params.provider,
			model: params.model,
			runId: params.runId,
			authProfile,
			allowTransientCooldownProbe: params.allowTransientCooldownProbe
		})
	};
}
//#endregion
export { resolveQueuedReplyExecutionConfig as a, resolveRunAuthProfile as c, isBunFetchSocketError as i, buildThreadingToolContext as n, resolveQueuedReplyRuntimeConfig as o, formatBunFetchSocketError as r, resolveModelFallbackOptions as s, buildEmbeddedRunExecutionParams as t };
