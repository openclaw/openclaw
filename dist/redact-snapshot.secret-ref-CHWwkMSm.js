//#region src/config/redact-snapshot.secret-ref.ts
function isSecretRefShape(value) {
	return typeof value.source === "string" && typeof value.id === "string";
}
function redactSecretRefId(params) {
	const { value, values, redactedSentinel, isEnvVarPlaceholder } = params;
	const redacted = { ...value };
	if (!isEnvVarPlaceholder(value.id)) {
		values.push(value.id);
		redacted.id = redactedSentinel;
	}
	return redacted;
}
//#endregion
export { redactSecretRefId as n, isSecretRefShape as t };
