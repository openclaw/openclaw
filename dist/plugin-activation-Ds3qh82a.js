import { l as resolveCodexPluginsPolicy, t as CODEX_PLUGINS_MARKETPLACE_NAME } from "./config-1YKbZ7CA.js";
import "node:path";
import "node:fs/promises";
var CodexAppInventoryCache = class {
	constructor(options = {}) {
		this.entries = /* @__PURE__ */ new Map();
		this.inFlight = /* @__PURE__ */ new Map();
		this.refreshTokens = /* @__PURE__ */ new Map();
		this.diagnostics = /* @__PURE__ */ new Map();
		this.revision = 0;
		this.ttlMs = options.ttlMs ?? 36e5;
	}
	read(params) {
		const nowMs = params.nowMs ?? Date.now();
		const entry = this.entries.get(params.key);
		if (!entry) {
			const refreshScheduled = this.scheduleRefresh(params);
			return {
				state: "missing",
				key: params.key,
				revision: this.revision,
				refreshScheduled,
				...this.diagnostics.get(params.key) ? { diagnostic: this.diagnostics.get(params.key) } : {}
			};
		}
		const state = entry.invalidated || entry.expiresAtMs <= nowMs ? "stale" : "fresh";
		const refreshScheduled = state === "fresh" && !params.forceRefetch ? false : this.scheduleRefresh(params);
		return {
			state,
			key: params.key,
			revision: entry.revision,
			snapshot: stripEntryState(entry),
			refreshScheduled,
			...entry.lastError ? { diagnostic: entry.lastError } : {}
		};
	}
	refreshNow(params) {
		return this.refresh(params);
	}
	invalidate(key, reason, nowMs = Date.now()) {
		this.revision += 1;
		const diagnostic = {
			message: reason,
			atMs: nowMs
		};
		const entry = this.entries.get(key);
		if (entry) {
			entry.invalidated = true;
			entry.lastError = diagnostic;
			entry.revision = this.revision;
		} else this.diagnostics.set(key, diagnostic);
		return this.revision;
	}
	clear() {
		this.entries.clear();
		this.inFlight.clear();
		this.refreshTokens.clear();
		this.diagnostics.clear();
		this.revision = 0;
	}
	getRevision() {
		return this.revision;
	}
	scheduleRefresh(params) {
		if (this.inFlight.has(params.key) && !params.forceRefetch) return true;
		const promise = this.refresh(params);
		this.inFlight.set(params.key, promise);
		promise.catch(() => void 0);
		return true;
	}
	async refresh(params) {
		const existing = this.inFlight.get(params.key);
		if (existing && !params.forceRefetch) return existing;
		const refreshToken = (this.refreshTokens.get(params.key) ?? 0) + 1;
		this.refreshTokens.set(params.key, refreshToken);
		const promise = this.refreshUncoalesced(params, refreshToken);
		this.inFlight.set(params.key, promise);
		try {
			return await promise;
		} finally {
			if (this.inFlight.get(params.key) === promise) this.inFlight.delete(params.key);
		}
	}
	async refreshUncoalesced(params, refreshToken) {
		const nowMs = params.nowMs ?? Date.now();
		try {
			const apps = await listAllApps(params.request, params.forceRefetch ?? false);
			this.revision += 1;
			const snapshot = {
				key: params.key,
				apps,
				fetchedAtMs: nowMs,
				expiresAtMs: nowMs + this.ttlMs,
				revision: this.revision
			};
			if (this.refreshTokens.get(params.key) === refreshToken) {
				this.entries.set(params.key, {
					...snapshot,
					invalidated: false
				});
				this.diagnostics.delete(params.key);
			}
			return snapshot;
		} catch (error) {
			const diagnostic = {
				message: error instanceof Error ? error.message : String(error),
				atMs: nowMs
			};
			this.diagnostics.set(params.key, diagnostic);
			const entry = this.entries.get(params.key);
			if (entry) entry.lastError = diagnostic;
			throw error;
		}
	}
};
const defaultCodexAppInventoryCache = new CodexAppInventoryCache();
function buildCodexAppInventoryCacheKey(input) {
	return JSON.stringify({
		codexHome: input.codexHome ?? null,
		endpoint: input.endpoint ?? null,
		authProfileId: input.authProfileId ?? null,
		accountId: input.accountId ?? null,
		envApiKeyFingerprint: input.envApiKeyFingerprint ?? null,
		appServerVersion: input.appServerVersion ?? null
	});
}
async function listAllApps(request, forceRefetch) {
	const apps = [];
	let cursor;
	do {
		const response = await request("app/list", {
			cursor,
			limit: 100,
			forceRefetch
		});
		apps.push(...response.data);
		cursor = response.nextCursor;
	} while (cursor);
	return apps;
}
function stripEntryState(entry) {
	const { invalidated: _invalidated, ...snapshot } = entry;
	return snapshot;
}
//#endregion
//#region extensions/codex/src/app-server/plugin-inventory.ts
async function readCodexPluginInventory(params) {
	const policy = params.policy ?? resolveCodexPluginsPolicy(params.pluginConfig);
	if (!policy.enabled) return {
		policy,
		records: [],
		diagnostics: [{
			code: "disabled",
			message: "Native Codex plugin support is disabled."
		}]
	};
	const appInventory = readCachedAppInventory(params);
	const marketplaceEntry = (await params.request("plugin/list", { cwds: [] })).marketplaces.find((marketplace) => marketplace.name === CODEX_PLUGINS_MARKETPLACE_NAME);
	if (!marketplaceEntry) return {
		policy,
		records: [],
		diagnostics: policy.pluginPolicies.filter((pluginPolicy) => pluginPolicy.enabled).map((pluginPolicy) => ({
			code: "marketplace_missing",
			plugin: pluginPolicy,
			message: `Codex marketplace ${CODEX_PLUGINS_MARKETPLACE_NAME} was not found.`
		})),
		...appInventory ? { appInventory } : {}
	};
	const marketplace = marketplaceRef(marketplaceEntry);
	const diagnostics = [];
	const records = [];
	if (appInventory?.state === "missing") diagnostics.push({
		code: "app_inventory_missing",
		message: "Cached Codex app inventory is missing; plugin apps are excluded for this setup."
	});
	else if (appInventory?.state === "stale") diagnostics.push({
		code: "app_inventory_stale",
		message: "Cached Codex app inventory is stale; using stale app readiness and refreshing."
	});
	for (const pluginPolicy of policy.pluginPolicies) {
		if (!pluginPolicy.enabled) continue;
		const summary = findPluginSummary(marketplaceEntry, pluginPolicy.pluginName);
		if (!summary) {
			diagnostics.push({
				code: "plugin_missing",
				plugin: pluginPolicy,
				message: `${pluginPolicy.pluginName} was not found in ${CODEX_PLUGINS_MARKETPLACE_NAME}.`
			});
			continue;
		}
		const detail = await readPluginDetail(params, marketplace, pluginPolicy, diagnostics);
		const ownedAppIds = detail?.apps.map((app) => app.id).filter(Boolean).toSorted() ?? [];
		const appOwnership = resolveAppOwnership({
			detail,
			appInventory,
			summary
		});
		if (appOwnership === "ambiguous") diagnostics.push({
			code: "app_ownership_ambiguous",
			plugin: pluginPolicy,
			message: `${pluginPolicy.pluginName} has only display-name app matches; apps are not exposed until ownership is stable.`
		});
		if (summary.installed && !summary.enabled) diagnostics.push({
			code: "plugin_disabled",
			plugin: pluginPolicy,
			message: `${pluginPolicy.pluginName} is installed in Codex but disabled.`
		});
		const apps = resolveOwnedApps({
			detail,
			appInventory
		});
		records.push({
			policy: pluginPolicy,
			summary,
			...detail ? { detail } : {},
			activationRequired: !summary.installed || !summary.enabled,
			authRequired: apps.some((app) => app.needsAuth || !app.accessible),
			appOwnership,
			ownedAppIds,
			apps
		});
	}
	return {
		policy,
		marketplace,
		records,
		diagnostics,
		...appInventory ? { appInventory } : {}
	};
}
function findOpenAiCuratedPluginSummary(listed, pluginName) {
	const marketplaceEntry = listed.marketplaces.find((marketplace) => marketplace.name === CODEX_PLUGINS_MARKETPLACE_NAME);
	if (!marketplaceEntry) return;
	const summary = findPluginSummary(marketplaceEntry, pluginName);
	return summary ? {
		marketplace: marketplaceRef(marketplaceEntry),
		summary
	} : void 0;
}
function pluginReadParams(marketplace, pluginName) {
	return {
		...marketplace.path ? { marketplacePath: marketplace.path } : {},
		...marketplace.remoteMarketplaceName ? { remoteMarketplaceName: marketplace.remoteMarketplaceName } : {},
		pluginName
	};
}
function readCachedAppInventory(params) {
	if (!params.appCache || !params.appCacheKey) return;
	const request = async (method, requestParams) => await params.request(method, requestParams);
	return params.appCache.read({
		key: params.appCacheKey,
		request,
		nowMs: params.nowMs
	});
}
async function readPluginDetail(params, marketplace, pluginPolicy, diagnostics) {
	if (params.readPluginDetails === false) return;
	try {
		return (await params.request("plugin/read", pluginReadParams(marketplace, pluginPolicy.pluginName))).plugin;
	} catch (error) {
		diagnostics.push({
			code: "plugin_detail_unavailable",
			plugin: pluginPolicy,
			message: `${pluginPolicy.pluginName} detail unavailable: ${error instanceof Error ? error.message : String(error)}`
		});
		return;
	}
}
function resolveAppOwnership(params) {
	if (params.detail && params.detail.apps.length > 0) return "proven";
	return (params.appInventory?.snapshot?.apps ?? []).filter((app) => app.pluginDisplayNames.some((displayName) => displayName === params.summary.name)).length > 0 ? "ambiguous" : "none";
}
function resolveOwnedApps(params) {
	const detailApps = params.detail?.apps ?? [];
	if (detailApps.length === 0) return [];
	if (params.appInventory?.state === "missing") return [];
	const appInfoById = new Map((params.appInventory?.snapshot?.apps ?? []).map((app) => [app.id, app]));
	return detailApps.map((app) => {
		const info = appInfoById.get(app.id);
		if (!info) return {
			id: app.id,
			name: app.name,
			accessible: false,
			enabled: false,
			needsAuth: true
		};
		return {
			id: app.id,
			name: app.name,
			accessible: info.isAccessible,
			enabled: info.isEnabled,
			needsAuth: app.needsAuth || !info.isAccessible
		};
	}).toSorted((left, right) => left.id.localeCompare(right.id));
}
function findPluginSummary(marketplace, pluginName) {
	return marketplace.plugins.find((plugin) => plugin.name === pluginName || plugin.id === pluginName || plugin.id === `${pluginName}@${marketplace.name}` || pluginNameFromPluginId(plugin.id, marketplace.name) === pluginName);
}
function pluginNameFromPluginId(pluginId, marketplaceName) {
	const trimmed = pluginId.trim();
	if (!trimmed) return;
	const marketplaceSuffix = `@${marketplaceName}`;
	return (trimmed.endsWith(marketplaceSuffix) ? trimmed.slice(0, -marketplaceSuffix.length) : trimmed).split("/").at(-1)?.trim() || void 0;
}
function marketplaceRef(marketplace) {
	return {
		name: CODEX_PLUGINS_MARKETPLACE_NAME,
		...marketplace.path ? { path: marketplace.path } : {},
		...!marketplace.path ? { remoteMarketplaceName: marketplace.name } : {}
	};
}
//#endregion
//#region extensions/codex/src/app-server/plugin-activation.ts
async function ensureCodexPluginActivation(params) {
	if (params.identity.marketplaceName !== "openai-curated") return activationFailure(params.identity, "marketplace_missing", { message: "Only " + CODEX_PLUGINS_MARKETPLACE_NAME + " plugins can be activated." });
	const resolved = findOpenAiCuratedPluginSummary(await params.request("plugin/list", { cwds: [] }), params.identity.pluginName);
	if (!resolved) return activationFailure(params.identity, "plugin_missing", { message: `${params.identity.pluginName} was not found in ${CODEX_PLUGINS_MARKETPLACE_NAME}.` });
	if (resolved.summary.installed && resolved.summary.enabled && !params.installEvenIfActive) return {
		identity: params.identity,
		ok: true,
		reason: "already_active",
		installAttempted: false,
		marketplace: resolved.marketplace,
		diagnostics: []
	};
	const installResponse = await params.request("plugin/install", pluginReadParams(resolved.marketplace, params.identity.pluginName));
	const refreshDiagnostics = [];
	let refreshFailed = false;
	try {
		const refreshResult = await refreshCodexPluginRuntimeState({
			request: params.request,
			appCache: params.appCache,
			appCacheKey: params.appCacheKey
		});
		refreshDiagnostics.push(...refreshResult.diagnostics);
	} catch (error) {
		refreshFailed = true;
		refreshDiagnostics.push({ message: `Codex plugin runtime refresh failed after install: ${error instanceof Error ? error.message : String(error)}` });
	}
	const authRequired = installResponse.appsNeedingAuth.length > 0;
	return {
		identity: params.identity,
		ok: !authRequired && !refreshFailed,
		reason: refreshFailed ? "refresh_failed" : authRequired ? "auth_required" : resolved.summary.installed && resolved.summary.enabled ? "already_active" : "installed",
		installAttempted: true,
		marketplace: resolved.marketplace,
		installResponse,
		diagnostics: [...refreshDiagnostics, ...installResponse.appsNeedingAuth.map((app) => ({ message: `${app.name} requires app authentication before plugin tools are exposed.` }))]
	};
}
async function refreshCodexPluginRuntimeState(params) {
	const diagnostics = [];
	await params.request("plugin/list", { cwds: [] });
	await params.request("skills/list", {
		cwds: [],
		forceReload: true
	});
	try {
		await params.request("hooks/list", { cwds: [] });
	} catch (error) {
		diagnostics.push({ message: `Codex hooks refresh skipped: ${error instanceof Error ? error.message : String(error)}` });
	}
	await params.request("config/mcpServer/reload", void 0);
	if (params.appCache && params.appCacheKey) {
		params.appCache.invalidate(params.appCacheKey, "Codex plugin activation changed app inventory");
		const request = async (method, requestParams) => await params.request(method, requestParams);
		try {
			await params.appCache.refreshNow({
				key: params.appCacheKey,
				request,
				forceRefetch: true
			});
		} catch (error) {
			diagnostics.push({ message: `Codex app inventory refresh skipped: ${error instanceof Error ? error.message : String(error)}` });
		}
	}
	return { diagnostics };
}
function activationFailure(identity, reason, diagnostic) {
	return {
		identity,
		ok: false,
		reason,
		installAttempted: false,
		diagnostics: [diagnostic]
	};
}
//#endregion
export { defaultCodexAppInventoryCache as a, buildCodexAppInventoryCacheKey as i, pluginReadParams as n, readCodexPluginInventory as r, ensureCodexPluginActivation as t };
