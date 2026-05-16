import { normalizeLowercaseStringOrEmpty, normalizeOptionalString, normalizeOptionalStringifiedId } from "openclaw/plugin-sdk/text-runtime";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/routing";
//#region extensions/discord/src/directory-cache.ts
const DISCORD_DIRECTORY_CACHE_MAX_ENTRIES = 4e3;
const DISCORD_DISCRIMINATOR_SUFFIX = /#\d{4}$/;
const DIRECTORY_HANDLE_CACHE = /* @__PURE__ */ new Map();
function normalizeAccountCacheKey(accountId) {
	return normalizeAccountId(accountId ?? DEFAULT_ACCOUNT_ID) || DEFAULT_ACCOUNT_ID;
}
function normalizeSnowflake(value) {
	const text = normalizeOptionalStringifiedId(value) ?? "";
	if (!/^\d+$/.test(text)) return null;
	return text;
}
function normalizeHandleKey(raw) {
	let handle = normalizeOptionalString(raw) ?? "";
	if (!handle) return null;
	if (handle.startsWith("@")) handle = normalizeOptionalString(handle.slice(1)) ?? "";
	if (!handle || /\s/.test(handle)) return null;
	return normalizeLowercaseStringOrEmpty(handle);
}
function ensureAccountCache(accountId) {
	const cacheKey = normalizeAccountCacheKey(accountId);
	const existing = DIRECTORY_HANDLE_CACHE.get(cacheKey);
	if (existing) return existing;
	const created = /* @__PURE__ */ new Map();
	DIRECTORY_HANDLE_CACHE.set(cacheKey, created);
	return created;
}
function setCacheEntry(cache, key, userId) {
	if (cache.has(key)) cache.delete(key);
	cache.set(key, userId);
	if (cache.size <= DISCORD_DIRECTORY_CACHE_MAX_ENTRIES) return;
	const oldest = cache.keys().next();
	if (!oldest.done) cache.delete(oldest.value);
}
function rememberDiscordDirectoryUser(params) {
	const userId = normalizeSnowflake(params.userId);
	if (!userId) return;
	const cache = ensureAccountCache(params.accountId);
	for (const candidate of params.handles) {
		if (typeof candidate !== "string") continue;
		const handle = normalizeHandleKey(candidate);
		if (!handle) continue;
		setCacheEntry(cache, handle, userId);
		const withoutDiscriminator = handle.replace(DISCORD_DISCRIMINATOR_SUFFIX, "");
		if (withoutDiscriminator && withoutDiscriminator !== handle) setCacheEntry(cache, withoutDiscriminator, userId);
	}
}
function resolveDiscordDirectoryUserId(params) {
	const cache = DIRECTORY_HANDLE_CACHE.get(normalizeAccountCacheKey(params.accountId));
	if (!cache) return;
	const handle = normalizeHandleKey(params.handle);
	if (!handle) return;
	const direct = cache.get(handle);
	if (direct) return direct;
	const withoutDiscriminator = handle.replace(DISCORD_DISCRIMINATOR_SUFFIX, "");
	if (!withoutDiscriminator || withoutDiscriminator === handle) return;
	return cache.get(withoutDiscriminator);
}
//#endregion
export { resolveDiscordDirectoryUserId as n, rememberDiscordDirectoryUser as t };
