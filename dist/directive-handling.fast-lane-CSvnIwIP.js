import { t as isDirectiveOnly } from "./directive-handling.directive-only-BxiwYVOD.js";
import { t as handleDirectiveOnly } from "./directive-handling.impl-Br_LlMLq.js";
import { t as resolveCurrentDirectiveLevels } from "./directive-handling.levels-DelffVqL.js";
//#region src/auto-reply/reply/directive-handling.fast-lane.ts
async function applyInlineDirectivesFastLane(params) {
	const { directives, commandAuthorized, ctx, cfg, agentId, isGroup, sessionEntry, sessionStore, sessionKey, storePath, elevatedEnabled, elevatedAllowed, elevatedFailures, messageProviderKey, defaultProvider, defaultModel, aliasIndex, allowedModelKeys, allowedModelCatalog, resetModelOverride, formatModelSwitchEvent, modelState } = params;
	let { provider, model } = params;
	if (!commandAuthorized || isDirectiveOnly({
		directives,
		cleanedBody: directives.cleaned,
		ctx,
		cfg,
		agentId,
		isGroup
	})) return {
		directiveAck: void 0,
		provider,
		model
	};
	const agentCfg = params.agentCfg;
	const { currentThinkLevel, currentFastMode, currentVerboseLevel, currentReasoningLevel, currentElevatedLevel } = await resolveCurrentDirectiveLevels({
		sessionEntry,
		agentCfg,
		resolveDefaultThinkingLevel: directives.hasThinkDirective ? () => modelState.resolveDefaultThinkingLevel() : async () => void 0
	});
	const directiveAck = await handleDirectiveOnly({
		cfg,
		directives,
		sessionEntry,
		sessionStore,
		sessionKey,
		storePath,
		elevatedEnabled,
		elevatedAllowed,
		elevatedFailures,
		messageProviderKey,
		defaultProvider,
		defaultModel,
		aliasIndex,
		allowedModelKeys,
		allowedModelCatalog,
		thinkingCatalog: await modelState.resolveThinkingCatalog(),
		resetModelOverride,
		provider,
		model,
		initialModelLabel: params.initialModelLabel,
		formatModelSwitchEvent,
		currentThinkLevel,
		currentFastMode,
		currentVerboseLevel,
		currentReasoningLevel,
		currentElevatedLevel,
		ctx,
		surface: ctx.Surface,
		gatewayClientScopes: ctx.GatewayClientScopes,
		senderIsOwner: params.senderIsOwner,
		workspaceDir: params.workspaceDir
	});
	if (sessionEntry?.providerOverride) provider = sessionEntry.providerOverride;
	if (sessionEntry?.modelOverride) model = sessionEntry.modelOverride;
	return {
		directiveAck,
		provider,
		model
	};
}
//#endregion
export { applyInlineDirectivesFastLane };
