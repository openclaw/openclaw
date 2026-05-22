import { s as normalizeOptionalLowercaseString } from "./string-coerce-Bje8XVt9.js";
//#region src/auto-reply/group-activation.ts
function normalizeGroupActivation(raw) {
	const value = normalizeOptionalLowercaseString(raw);
	if (value === "mention") return "mention";
	if (value === "always") return "always";
}
function parseActivationCommand(raw) {
	if (!raw) return { hasCommand: false };
	const trimmed = raw.trim();
	if (!trimmed) return { hasCommand: false };
	const match = trimmed.replace(/^\/([^\s:]+)\s*:(.*)$/, (_, cmd, rest) => {
		const trimmedRest = rest.trimStart();
		return trimmedRest ? `/${cmd} ${trimmedRest}` : `/${cmd}`;
	}).match(/^\/activation(?:\s+([a-zA-Z]+))?\s*$/i);
	if (!match) return { hasCommand: false };
	return {
		hasCommand: true,
		mode: normalizeGroupActivation(match[1])
	};
}
//#endregion
export { parseActivationCommand as n, normalizeGroupActivation as t };
