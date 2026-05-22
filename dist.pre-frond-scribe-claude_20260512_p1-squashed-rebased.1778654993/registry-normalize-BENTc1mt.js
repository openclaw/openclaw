import { s as normalizeOptionalLowercaseString } from "./string-coerce-LndEvhRk.js";
import { t as findRegisteredChannelPluginEntry } from "./registry-lookup-D6Abs-7z.js";
//#region src/channels/registry-normalize.ts
function normalizeAnyChannelId(raw) {
	const key = normalizeOptionalLowercaseString(raw);
	if (!key) return null;
	return findRegisteredChannelPluginEntry(key)?.plugin.id ?? null;
}
//#endregion
export { normalizeAnyChannelId as t };
