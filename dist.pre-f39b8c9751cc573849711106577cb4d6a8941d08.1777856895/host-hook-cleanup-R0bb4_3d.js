import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-Bje8XVt9.js";
import { r as clearPluginRunContext, t as cleanupPluginSessionSchedulerJobs } from "./host-hook-runtime-DiP9En9h.js";
import { r as resolveAllAgentSessionStoreTargetsSync } from "./targets-DQ0LYF_r.js";
import { o as updateSessionStore } from "./store-C0WV070A.js";
import fs from "node:fs";
//#region src/plugins/host-hook-cleanup.ts
function shouldCleanPlugin(pluginId, filterPluginId) {
	return !filterPluginId || pluginId === filterPluginId;
}
function clearPluginOwnedSessionState(entry, pluginId) {
	if (!pluginId) {
		delete entry.pluginExtensions;
		delete entry.pluginNextTurnInjections;
		return;
	}
	if (entry.pluginExtensions) {
		delete entry.pluginExtensions[pluginId];
		if (Object.keys(entry.pluginExtensions).length === 0) delete entry.pluginExtensions;
	}
	if (entry.pluginNextTurnInjections) {
		delete entry.pluginNextTurnInjections[pluginId];
		if (Object.keys(entry.pluginNextTurnInjections).length === 0) delete entry.pluginNextTurnInjections;
	}
}
function hasPluginOwnedSessionState(entry, pluginId) {
	if (!pluginId) return Boolean(entry.pluginExtensions || entry.pluginNextTurnInjections);
	return Boolean(entry.pluginExtensions?.[pluginId] || entry.pluginNextTurnInjections?.[pluginId]);
}
function matchesCleanupSession(entryKey, entry, sessionKey) {
	const normalizedSessionKey = normalizeLowercaseStringOrEmpty(sessionKey);
	if (!normalizedSessionKey) return true;
	return normalizeLowercaseStringOrEmpty(entryKey) === normalizedSessionKey || normalizeLowercaseStringOrEmpty(entry.sessionId) === normalizedSessionKey;
}
async function clearPluginOwnedSessionStores(params) {
	if (!params.pluginId && !params.sessionKey) return 0;
	const storePaths = new Set(resolveAllAgentSessionStoreTargetsSync(params.cfg).map((target) => target.storePath).filter((storePath) => fs.existsSync(storePath)));
	let cleared = 0;
	for (const storePath of storePaths) cleared += await updateSessionStore(storePath, (store) => {
		let clearedInStore = 0;
		const now = Date.now();
		for (const [entryKey, entry] of Object.entries(store)) {
			if (!matchesCleanupSession(entryKey, entry, params.sessionKey) || !hasPluginOwnedSessionState(entry, params.pluginId)) continue;
			clearPluginOwnedSessionState(entry, params.pluginId);
			entry.updatedAt = now;
			clearedInStore += 1;
		}
		return clearedInStore;
	});
	return cleared;
}
async function runPluginHostCleanup(params) {
	const persistentCleanupCount = params.reason === "restart" ? 0 : await clearPluginOwnedSessionStores({
		cfg: params.cfg,
		pluginId: params.pluginId,
		sessionKey: params.sessionKey
	});
	const registry = params.registry;
	if (!registry) return {
		cleanupCount: persistentCleanupCount,
		failures: []
	};
	const failures = [];
	let cleanupCount = persistentCleanupCount;
	for (const registration of registry.sessionExtensions ?? []) {
		if (!shouldCleanPlugin(registration.pluginId, params.pluginId)) continue;
		const cleanup = registration.extension.cleanup;
		if (!cleanup) continue;
		try {
			await cleanup({
				reason: params.reason,
				sessionKey: params.sessionKey
			});
			cleanupCount += 1;
		} catch (error) {
			failures.push({
				pluginId: registration.pluginId,
				hookId: `session:${registration.extension.namespace}`,
				error
			});
		}
	}
	for (const registration of registry.runtimeLifecycles ?? []) {
		if (!shouldCleanPlugin(registration.pluginId, params.pluginId)) continue;
		const cleanup = registration.lifecycle.cleanup;
		if (!cleanup) continue;
		try {
			await cleanup({
				reason: params.reason,
				sessionKey: params.sessionKey,
				runId: params.runId
			});
			cleanupCount += 1;
		} catch (error) {
			failures.push({
				pluginId: registration.pluginId,
				hookId: `runtime:${registration.lifecycle.id}`,
				error
			});
		}
	}
	const schedulerFailures = await cleanupPluginSessionSchedulerJobs({
		pluginId: params.pluginId,
		reason: params.reason,
		sessionKey: params.sessionKey,
		records: registry?.sessionSchedulerJobs,
		preserveJobIds: params.preserveSchedulerJobIds
	});
	for (const failure of schedulerFailures) failures.push(failure);
	if (params.pluginId || params.runId) clearPluginRunContext({
		pluginId: params.pluginId,
		runId: params.runId
	});
	return {
		cleanupCount,
		failures
	};
}
function collectHostHookPluginIds(registry) {
	const ids = /* @__PURE__ */ new Set();
	for (const registration of registry.sessionExtensions ?? []) ids.add(registration.pluginId);
	for (const registration of registry.runtimeLifecycles ?? []) ids.add(registration.pluginId);
	for (const registration of registry.agentEventSubscriptions ?? []) ids.add(registration.pluginId);
	for (const registration of registry.sessionSchedulerJobs ?? []) ids.add(registration.pluginId);
	return ids;
}
function collectLoadedPluginIds(registry) {
	return new Set(registry.plugins.filter((plugin) => plugin.status === "loaded").map((plugin) => plugin.id));
}
function collectSchedulerJobIds(registry, pluginId) {
	return new Set((registry?.sessionSchedulerJobs ?? []).filter((registration) => registration.pluginId === pluginId).map((registration) => typeof registration.job.id === "string" ? registration.job.id.trim() : "").filter(Boolean));
}
async function cleanupReplacedPluginHostRegistry(params) {
	const previousRegistry = params.previousRegistry;
	if (!previousRegistry || previousRegistry === params.nextRegistry) return {
		cleanupCount: 0,
		failures: []
	};
	const nextPluginIds = params.nextRegistry ? collectLoadedPluginIds(params.nextRegistry) : /* @__PURE__ */ new Set();
	const previousPluginIds = new Set([...collectLoadedPluginIds(previousRegistry), ...collectHostHookPluginIds(previousRegistry)]);
	const failures = [];
	let cleanupCount = 0;
	for (const pluginId of previousPluginIds) {
		const restarted = nextPluginIds.has(pluginId);
		const result = await runPluginHostCleanup({
			cfg: params.cfg,
			registry: previousRegistry,
			pluginId,
			reason: restarted ? "restart" : "disable",
			preserveSchedulerJobIds: restarted ? collectSchedulerJobIds(params.nextRegistry, pluginId) : void 0
		});
		cleanupCount += result.cleanupCount;
		failures.push(...result.failures);
	}
	return {
		cleanupCount,
		failures
	};
}
//#endregion
export { clearPluginOwnedSessionState as n, runPluginHostCleanup as r, cleanupReplacedPluginHostRegistry as t };
