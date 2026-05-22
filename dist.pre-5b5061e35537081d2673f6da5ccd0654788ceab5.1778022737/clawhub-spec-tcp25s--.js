import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-Bje8XVt9.js";
//#region src/infra/clawhub-spec.ts
function parseClawHubPluginSpec(raw) {
	const trimmed = raw.trim();
	if (!normalizeLowercaseStringOrEmpty(trimmed).startsWith("clawhub:")) return null;
	const spec = trimmed.slice(8).trim();
	if (!spec) return null;
	const atIndex = spec.lastIndexOf("@");
	if (atIndex <= 0) return { name: spec };
	if (atIndex >= spec.length - 1) return null;
	const name = spec.slice(0, atIndex).trim();
	const version = spec.slice(atIndex + 1).trim();
	if (!name || !version) return null;
	return {
		name,
		version
	};
}
//#endregion
export { parseClawHubPluginSpec as t };
