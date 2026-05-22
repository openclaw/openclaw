import { s as normalizeOptionalLowercaseString } from "./string-coerce-LndEvhRk.js";
import { t as findRegisteredChannelPluginEntry } from "./registry-lookup-5ZKa5BSl.js";
//#region src/channels/registry-normalize.ts
function normalizeAnyChannelId(raw) {
	const key = normalizeOptionalLowercaseString(raw);
	if (!key) return null;
	return findRegisteredChannelPluginEntry(key)?.plugin.id ?? null;
}
//#endregion
export { normalizeAnyChannelId as t };
