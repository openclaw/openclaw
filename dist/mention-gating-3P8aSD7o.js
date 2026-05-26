//#region src/channels/mention-gating.ts
function implicitMentionKindWhen(kind, enabled) {
	return enabled ? [kind] : [];
}
function resolveMatchedImplicitMentionKinds(params) {
	const inputKinds = params.implicitMentionKinds ?? [];
	if (inputKinds.length === 0) return [];
	const allowedKinds = params.allowedImplicitMentionKinds ? new Set(params.allowedImplicitMentionKinds) : null;
	const matched = [];
	for (const kind of inputKinds) {
		if (allowedKinds && !allowedKinds.has(kind)) continue;
		if (!matched.includes(kind)) matched.push(kind);
	}
	return matched;
}
function resolveMentionDecisionCore(params) {
	const matchedImplicitMentionKinds = resolveMatchedImplicitMentionKinds({
		implicitMentionKinds: params.implicitMentionKinds,
		allowedImplicitMentionKinds: params.allowedImplicitMentionKinds
	});
	const implicitMention = matchedImplicitMentionKinds.length > 0;
	const effectiveWasMentioned = params.wasMentioned || implicitMention || params.shouldBypassMention;
	const shouldSkip = params.requireMention && params.canDetectMention && !effectiveWasMentioned;
	return {
		implicitMention,
		matchedImplicitMentionKinds,
		effectiveWasMentioned,
		shouldBypassMention: params.shouldBypassMention,
		shouldSkip
	};
}
function hasNestedMentionDecisionParams(params) {
	return "facts" in params && "policy" in params;
}
function normalizeMentionDecisionParams(params) {
	if (hasNestedMentionDecisionParams(params)) return params;
	const { canDetectMention, wasMentioned, hasAnyMention, implicitMentionKinds, isGroup, requireMention, allowedImplicitMentionKinds, allowTextCommands, hasControlCommand, commandAuthorized } = params;
	return {
		facts: {
			canDetectMention,
			wasMentioned,
			hasAnyMention,
			implicitMentionKinds
		},
		policy: {
			isGroup,
			requireMention,
			allowedImplicitMentionKinds,
			allowTextCommands,
			hasControlCommand,
			commandAuthorized
		}
	};
}
function resolveInboundMentionDecision(params) {
	const { facts, policy } = normalizeMentionDecisionParams(params);
	const shouldBypassMention = policy.isGroup && policy.requireMention && !facts.wasMentioned && !(facts.hasAnyMention ?? false) && policy.allowTextCommands && policy.commandAuthorized && policy.hasControlCommand;
	return resolveMentionDecisionCore({
		requireMention: policy.requireMention,
		canDetectMention: facts.canDetectMention,
		wasMentioned: facts.wasMentioned,
		implicitMentionKinds: facts.implicitMentionKinds,
		allowedImplicitMentionKinds: policy.allowedImplicitMentionKinds,
		shouldBypassMention
	});
}
/** @deprecated Prefer `resolveInboundMentionDecision({ facts, policy })`. */
function resolveMentionGating(params) {
	const result = resolveMentionDecisionCore({
		requireMention: params.requireMention,
		canDetectMention: params.canDetectMention,
		wasMentioned: params.wasMentioned,
		implicitMentionKinds: implicitMentionKindWhen("native", params.implicitMention === true),
		shouldBypassMention: params.shouldBypassMention === true
	});
	return {
		effectiveWasMentioned: result.effectiveWasMentioned,
		shouldSkip: result.shouldSkip
	};
}
/** @deprecated Prefer `resolveInboundMentionDecision({ facts, policy })`. */
function resolveMentionGatingWithBypass(params) {
	const result = resolveInboundMentionDecision({
		facts: {
			canDetectMention: params.canDetectMention,
			wasMentioned: params.wasMentioned,
			hasAnyMention: params.hasAnyMention,
			implicitMentionKinds: implicitMentionKindWhen("native", params.implicitMention === true)
		},
		policy: {
			isGroup: params.isGroup,
			requireMention: params.requireMention,
			allowTextCommands: params.allowTextCommands,
			hasControlCommand: params.hasControlCommand,
			commandAuthorized: params.commandAuthorized
		}
	});
	return {
		effectiveWasMentioned: result.effectiveWasMentioned,
		shouldSkip: result.shouldSkip,
		shouldBypassMention: result.shouldBypassMention
	};
}
//#endregion
export { resolveMentionGatingWithBypass as i, resolveInboundMentionDecision as n, resolveMentionGating as r, implicitMentionKindWhen as t };
