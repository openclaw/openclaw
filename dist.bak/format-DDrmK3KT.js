//#region src/commands/status-all/format.ts
function formatGatewayAuthUsed(auth) {
	const hasToken = Boolean(auth?.token?.trim());
	const hasPassword = Boolean(auth?.password?.trim());
	if (hasToken && hasPassword) return "token+password";
	if (hasToken) return "token";
	if (hasPassword) return "password";
	return "none";
}
function redactSecrets(text) {
	if (!text) return text;
	let out = text;
	out = out.replace(/(\b(?:access[_-]?token|refresh[_-]?token|token|password|secret|api[_-]?key)\b\s*[:=]\s*)("?)([^"\\s]+)("?)/gi, "$1$2***$4");
	out = out.replace(/\bBearer\s+[A-Za-z0-9._-]+\b/g, "Bearer ***");
	out = out.replace(/\bsk-[A-Za-z0-9]{10,}\b/g, "sk-***");
	return out;
}

//#endregion
export { redactSecrets as n, formatGatewayAuthUsed as t };