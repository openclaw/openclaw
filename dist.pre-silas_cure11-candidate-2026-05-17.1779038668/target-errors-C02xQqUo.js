//#region src/infra/outbound/target-errors.ts
function missingTargetMessage(provider, hint) {
	return `Delivering to ${provider} requires target${formatTargetHint(hint)}`;
}
function missingTargetError(provider, hint) {
	return new Error(missingTargetMessage(provider, hint));
}
function ambiguousTargetMessage(provider, raw, hint) {
	return `Ambiguous target "${raw}" for ${provider}. Provide a unique name or an explicit id.${formatTargetHint(hint, true)}`;
}
function ambiguousTargetError(provider, raw, hint) {
	return new Error(ambiguousTargetMessage(provider, raw, hint));
}
function unknownTargetMessage(provider, raw, hint) {
	return `Unknown target "${raw}" for ${provider}.${formatTargetHint(hint, true)}`;
}
function unknownTargetError(provider, raw, hint) {
	return new Error(unknownTargetMessage(provider, raw, hint));
}
function formatTargetHint(hint, withLabel = false) {
	const normalized = hint?.trim();
	if (!normalized) return "";
	return withLabel ? ` Hint: ${normalized}` : ` ${normalized}`;
}
//#endregion
export { missingTargetError as n, unknownTargetError as r, ambiguousTargetError as t };
