import { g as normalizeAccountId, v as isBlockedObjectKey } from "./session-key-CbP51u9x.js";
//#region src/plugin-sdk/allowlist-resolution.ts
/** Clone allowlist resolution entries into a plain serializable shape for UI and docs output. */
function mapBasicAllowlistResolutionEntries(entries) {
	return entries.map((entry) => ({
		input: entry.input,
		resolved: entry.resolved,
		id: entry.id,
		name: entry.name,
		note: entry.note
	}));
}
/** Map allowlist inputs sequentially so resolver side effects stay ordered and predictable. */
async function mapAllowlistResolutionInputs(params) {
	const results = [];
	for (const input of params.inputs) {results.push(await params.mapInput(input));}
	return results;
}
//#endregion
//#region src/plugin-sdk/discord-send.ts
/** Build the common Discord send options from SDK-level reply payload fields. */
function buildDiscordSendOptions(input) {
	return {
		verbose: false,
		replyTo: input.replyToId ?? void 0,
		accountId: input.accountId ?? void 0,
		silent: input.silent ?? void 0
	};
}
/** Extend the base Discord send options with media-specific fields. */
function buildDiscordSendMediaOptions(input) {
	return {
		...buildDiscordSendOptions(input),
		mediaUrl: input.mediaUrl,
		mediaLocalRoots: input.mediaLocalRoots
	};
}
/** Stamp raw Discord send results with the channel id expected by shared outbound flows. */
function tagDiscordChannelResult(result) {
	return {
		channel: "discord",
		...result
	};
}
//#endregion
//#region src/plugin-sdk/resolution-notes.ts
/** Format a short note that separates successfully resolved targets from unresolved passthrough values. */
function formatResolvedUnresolvedNote(params) {
	if (params.resolved.length === 0 && params.unresolved.length === 0) {return;}
	return [params.resolved.length > 0 ? `Resolved: ${params.resolved.join(", ")}` : void 0, params.unresolved.length > 0 ? `Unresolved (kept as typed): ${params.unresolved.join(", ")}` : void 0].filter(Boolean).join("\n");
}
//#endregion
//#region src/plugin-sdk/allowlist-config-edit.ts
function resolveAccountScopedWriteTarget(parsed, channelId, accountId) {
	const channels = parsed.channels ??= {};
	const channel = channels[channelId] ??= {};
	const normalizedAccountId = normalizeAccountId(accountId);
	if (isBlockedObjectKey(normalizedAccountId)) {return {
		target: channel,
		pathPrefix: `channels.${channelId}`,
		writeTarget: {
			kind: "channel",
			scope: { channelId }
		}
	};}
	const hasAccounts = Boolean(channel.accounts && typeof channel.accounts === "object");
	if (!(normalizedAccountId !== "default" || hasAccounts)) {return {
		target: channel,
		pathPrefix: `channels.${channelId}`,
		writeTarget: {
			kind: "channel",
			scope: { channelId }
		}
	};}
	const accounts = channel.accounts ??= {};
	const existingAccount = Object.hasOwn(accounts, normalizedAccountId) ? accounts[normalizedAccountId] : void 0;
	if (!existingAccount || typeof existingAccount !== "object") {accounts[normalizedAccountId] = {};}
	return {
		target: accounts[normalizedAccountId],
		pathPrefix: `channels.${channelId}.accounts.${normalizedAccountId}`,
		writeTarget: {
			kind: "account",
			scope: {
				channelId,
				accountId: normalizedAccountId
			}
		}
	};
}
function getNestedValue(root, path) {
	let current = root;
	for (const key of path) {
		if (!current || typeof current !== "object") {return;}
		current = current[key];
	}
	return current;
}
function ensureNestedObject(root, path) {
	let current = root;
	for (const key of path) {
		const existing = current[key];
		if (!existing || typeof existing !== "object") {current[key] = {};}
		current = current[key];
	}
	return current;
}
function setNestedValue(root, path, value) {
	if (path.length === 0) {return;}
	if (path.length === 1) {
		root[path[0]] = value;
		return;
	}
	const parent = ensureNestedObject(root, path.slice(0, -1));
	parent[path[path.length - 1]] = value;
}
function deleteNestedValue(root, path) {
	if (path.length === 0) {return;}
	if (path.length === 1) {
		delete root[path[0]];
		return;
	}
	const parent = getNestedValue(root, path.slice(0, -1));
	if (!parent || typeof parent !== "object") {return;}
	delete parent[path[path.length - 1]];
}
function applyAccountScopedAllowlistConfigEdit(params) {
	const resolvedTarget = resolveAccountScopedWriteTarget(params.parsedConfig, params.channelId, params.accountId);
	const existing = [];
	for (const path of params.paths.readPaths) {
		const existingRaw = getNestedValue(resolvedTarget.target, path);
		if (!Array.isArray(existingRaw)) {continue;}
		for (const entry of existingRaw) {
			const value = String(entry).trim();
			if (!value || existing.includes(value)) {continue;}
			existing.push(value);
		}
	}
	const normalizedEntry = params.normalize([params.entry]);
	if (normalizedEntry.length === 0) {return { kind: "invalid-entry" };}
	const existingNormalized = params.normalize(existing);
	const shouldMatch = (value) => normalizedEntry.includes(value);
	let changed = false;
	let next = existing;
	const configHasEntry = existingNormalized.some((value) => shouldMatch(value));
	if (params.action === "add") {
		if (!configHasEntry) {
			next = [...existing, params.entry.trim()];
			changed = true;
		}
	} else {
		const keep = [];
		for (const entry of existing) {
			if (params.normalize([entry]).some((value) => shouldMatch(value))) {
				changed = true;
				continue;
			}
			keep.push(entry);
		}
		next = keep;
	}
	if (changed) {
		if (next.length === 0) {deleteNestedValue(resolvedTarget.target, params.paths.writePath);}
		else {setNestedValue(resolvedTarget.target, params.paths.writePath, next);}
		for (const path of params.paths.cleanupPaths ?? []) {deleteNestedValue(resolvedTarget.target, path);}
	}
	return {
		kind: "ok",
		changed,
		pathLabel: `${resolvedTarget.pathPrefix}.${params.paths.writePath.join(".")}`,
		writeTarget: resolvedTarget.writeTarget
	};
}
/** Build the default account-scoped allowlist editor used by channel plugins with config-backed lists. */
function buildAccountScopedAllowlistConfigEditor(params) {
	return ({ cfg, parsedConfig, accountId, scope, action, entry }) => {
		const paths = params.resolvePaths(scope);
		if (!paths) {return null;}
		return applyAccountScopedAllowlistConfigEdit({
			parsedConfig,
			channelId: params.channelId,
			accountId,
			action,
			entry,
			normalize: (values) => params.normalize({
				cfg,
				accountId,
				values
			}),
			paths
		});
	};
}
//#endregion
//#region src/plugin-sdk/ssrf-policy.ts
function normalizeHostnameSuffix(value) {
	const trimmed = value.trim().toLowerCase();
	if (!trimmed) {return "";}
	if (trimmed === "*" || trimmed === "*.") {return "*";}
	return trimmed.replace(/^\*\.?/, "").replace(/^\.+/, "").replace(/\.+$/, "");
}
function isHostnameAllowedBySuffixAllowlist(hostname, allowlist) {
	if (allowlist.includes("*")) {return true;}
	const normalized = hostname.toLowerCase();
	return allowlist.some((entry) => normalized === entry || normalized.endsWith(`.${entry}`));
}
/** Normalize suffix-style host allowlists into lowercase canonical entries with wildcard collapse. */
function normalizeHostnameSuffixAllowlist(input, defaults) {
	const source = input && input.length > 0 ? input : defaults;
	if (!source || source.length === 0) {return [];}
	const normalized = source.map(normalizeHostnameSuffix).filter(Boolean);
	if (normalized.includes("*")) {return ["*"];}
	return Array.from(new Set(normalized));
}
/** Check whether a URL is HTTPS and its hostname matches the normalized suffix allowlist. */
function isHttpsUrlAllowedByHostnameSuffixAllowlist(url, allowlist) {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "https:") {return false;}
		return isHostnameAllowedBySuffixAllowlist(parsed.hostname, allowlist);
	} catch {
		return false;
	}
}
/**
* Converts suffix-style host allowlists (for example "example.com") into SSRF
* hostname allowlist patterns used by the shared fetch guard.
*
* Suffix semantics:
* - "example.com" allows "example.com" and "*.example.com"
* - "*" disables hostname allowlist restrictions
*/
function buildHostnameAllowlistPolicyFromSuffixAllowlist(allowHosts) {
	const normalizedAllowHosts = normalizeHostnameSuffixAllowlist(allowHosts);
	if (normalizedAllowHosts.length === 0) {return;}
	const patterns = /* @__PURE__ */ new Set();
	for (const normalized of normalizedAllowHosts) {
		if (normalized === "*") {return;}
		patterns.add(normalized);
		patterns.add(`*.${normalized}`);
	}
	if (patterns.size === 0) {return;}
	return { hostnameAllowlist: Array.from(patterns) };
}
//#endregion
//#region src/plugin-sdk/fetch-auth.ts
function isAuthFailureStatus(status) {
	return status === 401 || status === 403;
}
/** Retry a fetch with bearer tokens from the provided scopes when the unauthenticated attempt fails. */
async function fetchWithBearerAuthScopeFallback(params) {
	const fetchFn = params.fetchFn ?? fetch;
	let parsedUrl;
	try {
		parsedUrl = new URL(params.url);
	} catch {
		throw new Error(`Invalid URL: ${params.url}`);
	}
	if (params.requireHttps === true && parsedUrl.protocol !== "https:") {throw new Error(`URL must use HTTPS: ${params.url}`);}
	const fetchOnce = (headers) => fetchFn(params.url, {
		...params.requestInit,
		...headers ? { headers } : {}
	});
	const firstAttempt = await fetchOnce();
	if (firstAttempt.ok) {return firstAttempt;}
	if (!params.tokenProvider) {return firstAttempt;}
	const shouldRetry = params.shouldRetry ?? ((response) => isAuthFailureStatus(response.status));
	if (!shouldRetry(firstAttempt)) {return firstAttempt;}
	if (params.shouldAttachAuth && !params.shouldAttachAuth(params.url)) {return firstAttempt;}
	for (const scope of params.scopes) {try {
		const token = await params.tokenProvider.getAccessToken(scope);
		const authHeaders = new Headers(params.requestInit?.headers);
		authHeaders.set("Authorization", `Bearer ${token}`);
		const authAttempt = await fetchOnce(authHeaders);
		if (authAttempt.ok) return authAttempt;
		if (!shouldRetry(authAttempt)) continue;
	} catch {}}
	return firstAttempt;
}
//#endregion
export { buildAccountScopedAllowlistConfigEditor as a, buildDiscordSendOptions as c, mapBasicAllowlistResolutionEntries as d, normalizeHostnameSuffixAllowlist as i, tagDiscordChannelResult as l, buildHostnameAllowlistPolicyFromSuffixAllowlist as n, formatResolvedUnresolvedNote as o, isHttpsUrlAllowedByHostnameSuffixAllowlist as r, buildDiscordSendMediaOptions as s, fetchWithBearerAuthScopeFallback as t, mapAllowlistResolutionInputs as u };
