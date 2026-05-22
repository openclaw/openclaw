import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
import { n as resolveGlobalSingleton } from "./global-singleton-COlWgaGc.js";
import { t as createSubsystemLogger } from "./subsystem-D1_uRCZT.js";
//#region src/plugins/host-hook-json.ts
const PLUGIN_JSON_VALUE_LIMITS = {
	maxDepth: 32,
	maxNodes: 4096,
	maxObjectKeys: 512,
	maxStringLength: 64 * 1024,
	maxSerializedBytes: 256 * 1024
};
function isPluginJsonValueWithinLimits(value, limits, state) {
	state.nodes += 1;
	if (state.nodes > limits.maxNodes || state.depth > limits.maxDepth) return false;
	if (value === null || typeof value === "boolean") return true;
	if (typeof value === "string") return value.length <= limits.maxStringLength;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) {
		state.depth += 1;
		const ok = value.every((entry) => isPluginJsonValueWithinLimits(entry, limits, state));
		state.depth -= 1;
		return ok;
	}
	if (typeof value !== "object") return false;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return false;
	const entries = Object.entries(value);
	if (entries.length > limits.maxObjectKeys) return false;
	state.depth += 1;
	const ok = entries.every(([key, entry]) => key.length <= limits.maxStringLength && isPluginJsonValueWithinLimits(entry, limits, state));
	state.depth -= 1;
	return ok;
}
function isPluginJsonValue(value) {
	if (!isPluginJsonValueWithinLimits(value, PLUGIN_JSON_VALUE_LIMITS, {
		depth: 0,
		nodes: 0
	})) return false;
	try {
		return Buffer.byteLength(JSON.stringify(value), "utf8") <= PLUGIN_JSON_VALUE_LIMITS.maxSerializedBytes;
	} catch {
		return false;
	}
}
//#endregion
//#region src/plugins/host-hooks.ts
function normalizePluginHostHookId(value) {
	return (value ?? "").trim();
}
function normalizeQueuedInjectionText(entry, placement) {
	const candidate = entry;
	if (candidate.placement !== placement || typeof candidate.text !== "string") return;
	return candidate.text.trim() || void 0;
}
function buildPluginAgentTurnPrepareContext(params) {
	const prepend = params.queuedInjections.map((entry) => normalizeQueuedInjectionText(entry, "prepend_context")).filter(Boolean);
	const append = params.queuedInjections.map((entry) => normalizeQueuedInjectionText(entry, "append_context")).filter(Boolean);
	return {
		...prepend.length > 0 ? { prependContext: prepend.join("\n\n") } : {},
		...append.length > 0 ? { appendContext: append.join("\n\n") } : {}
	};
}
//#endregion
//#region src/plugins/host-hook-runtime.ts
const PLUGIN_HOST_RUNTIME_STATE_KEY = Symbol.for("openclaw.pluginHostRuntimeState");
const CLOSED_RUN_IDS_MAX = 512;
const log = createSubsystemLogger("plugins/host-hooks");
function getPluginHostRuntimeState() {
	return resolveGlobalSingleton(PLUGIN_HOST_RUNTIME_STATE_KEY, () => ({
		runContextByRunId: /* @__PURE__ */ new Map(),
		schedulerJobsByPlugin: /* @__PURE__ */ new Map(),
		nextSchedulerJobGeneration: 1,
		pendingAgentEventHandlersByRunId: /* @__PURE__ */ new Map(),
		closedRunIds: /* @__PURE__ */ new Set()
	}));
}
function normalizeNamespace(value) {
	return (value ?? "").trim();
}
function copyJsonValue(value) {
	return structuredClone(value);
}
function markPluginRunClosed(runId) {
	const state = getPluginHostRuntimeState();
	state.closedRunIds.delete(runId);
	state.closedRunIds.add(runId);
	while (state.closedRunIds.size > CLOSED_RUN_IDS_MAX) {
		const oldest = state.closedRunIds.values().next().value;
		if (oldest === void 0) break;
		state.closedRunIds.delete(oldest);
	}
}
function isPluginRunClosed(runId) {
	return getPluginHostRuntimeState().closedRunIds.has(runId);
}
function trackAgentEventHandler(runId, pending) {
	const state = getPluginHostRuntimeState();
	const handlers = state.pendingAgentEventHandlersByRunId.get(runId) ?? /* @__PURE__ */ new Set();
	handlers.add(pending);
	state.pendingAgentEventHandlersByRunId.set(runId, handlers);
	pending.finally(() => {
		handlers.delete(pending);
		if (handlers.size === 0) state.pendingAgentEventHandlersByRunId.delete(runId);
	});
}
function getPluginRunContextNamespaces(params) {
	const state = getPluginHostRuntimeState();
	let byPlugin = state.runContextByRunId.get(params.runId);
	if (!byPlugin && params.create) {
		byPlugin = /* @__PURE__ */ new Map();
		state.runContextByRunId.set(params.runId, byPlugin);
	}
	if (!byPlugin) return;
	let namespaces = byPlugin.get(params.pluginId);
	if (!namespaces && params.create) {
		namespaces = /* @__PURE__ */ new Map();
		byPlugin.set(params.pluginId, namespaces);
	}
	return namespaces;
}
function setPluginRunContext(params) {
	const runId = normalizeOptionalString(params.patch.runId);
	const namespace = normalizeNamespace(params.patch.namespace);
	if (!runId || !namespace) return false;
	if (isPluginRunClosed(runId)) return false;
	if (params.patch.unset === true) {
		clearPluginRunContext({
			pluginId: params.pluginId,
			runId,
			namespace
		});
		return true;
	}
	if (params.patch.value === void 0) return false;
	if (!isPluginJsonValue(params.patch.value)) return false;
	getPluginRunContextNamespaces({
		runId,
		pluginId: params.pluginId,
		create: true
	})?.set(namespace, copyJsonValue(params.patch.value));
	return true;
}
function getPluginRunContext(params) {
	const runId = normalizeOptionalString(params.get.runId);
	const namespace = normalizeNamespace(params.get.namespace);
	if (!runId || !namespace) return;
	const value = getPluginRunContextNamespaces({
		runId,
		pluginId: params.pluginId
	})?.get(namespace);
	return value === void 0 ? void 0 : copyJsonValue(value);
}
function clearPluginRunContext(params) {
	const normalizedNamespace = params.namespace !== void 0 ? normalizeNamespace(params.namespace) : void 0;
	const namespaceFilter = normalizedNamespace !== void 0 && normalizedNamespace !== "" ? normalizedNamespace : void 0;
	const state = getPluginHostRuntimeState();
	const runIds = params.runId ? [params.runId] : [...state.runContextByRunId.keys()];
	for (const runId of runIds) {
		const byPlugin = state.runContextByRunId.get(runId);
		if (!byPlugin) continue;
		const pluginIds = params.pluginId ? [params.pluginId] : [...byPlugin.keys()];
		for (const pluginId of pluginIds) {
			const namespaces = byPlugin.get(pluginId);
			if (!namespaces) continue;
			if (namespaceFilter !== void 0) namespaces.delete(namespaceFilter);
			else namespaces.clear();
			if (namespaces.size === 0) byPlugin.delete(pluginId);
		}
		if (byPlugin.size === 0) state.runContextByRunId.delete(runId);
	}
	if (params.runId && !params.pluginId && namespaceFilter === void 0) state.pendingAgentEventHandlersByRunId.delete(params.runId);
}
function isTerminalAgentRunEvent(event) {
	const phase = event.data?.phase;
	return event.stream === "lifecycle" && (phase === "end" || phase === "error");
}
function logAgentEventSubscriptionFailure(params) {
	log.warn(`plugin agent event subscription failed: plugin=${params.pluginId} subscription=${params.subscriptionId} error=${String(params.error)}`);
}
function dispatchPluginAgentEventSubscriptions(params) {
	const subscriptions = params.registry?.agentEventSubscriptions ?? [];
	const pendingHandlers = [];
	for (const registration of subscriptions) {
		const streams = registration.subscription.streams;
		if (streams && streams.length > 0 && !streams.includes(params.event.stream)) continue;
		const pluginId = registration.pluginId;
		const runId = params.event.runId;
		const ctx = {
			getRunContext: (namespace) => getPluginRunContext({
				pluginId,
				get: {
					runId,
					namespace
				}
			}),
			setRunContext: (namespace, value) => {
				setPluginRunContext({
					pluginId,
					patch: {
						runId,
						namespace,
						value
					}
				});
			},
			clearRunContext: (namespace) => {
				clearPluginRunContext({
					pluginId,
					runId,
					namespace
				});
			}
		};
		try {
			const pending = Promise.resolve(registration.subscription.handle(structuredClone(params.event), ctx)).catch((error) => {
				logAgentEventSubscriptionFailure({
					pluginId,
					subscriptionId: registration.subscription.id,
					error
				});
			});
			trackAgentEventHandler(runId, pending);
			pendingHandlers.push(pending);
		} catch (error) {
			logAgentEventSubscriptionFailure({
				pluginId,
				subscriptionId: registration.subscription.id,
				error
			});
		}
	}
	if (isTerminalAgentRunEvent(params.event)) {
		markPluginRunClosed(params.event.runId);
		const pendingForRun = getPluginHostRuntimeState().pendingAgentEventHandlersByRunId.get(params.event.runId) ?? new Set(pendingHandlers);
		Promise.allSettled(pendingForRun).then(() => {
			clearPluginRunContext({ runId: params.event.runId });
		});
	}
}
function registerPluginSessionSchedulerJob(params) {
	const id = normalizeOptionalString(params.job.id);
	const sessionKey = normalizeOptionalString(params.job.sessionKey);
	const kind = normalizeOptionalString(params.job.kind);
	if (!id || !sessionKey || !kind) return;
	const state = getPluginHostRuntimeState();
	const jobs = state.schedulerJobsByPlugin.get(params.pluginId) ?? /* @__PURE__ */ new Map();
	const generation = state.nextSchedulerJobGeneration++;
	jobs.set(id, {
		pluginId: params.pluginId,
		pluginName: params.pluginName,
		job: {
			...params.job,
			id,
			sessionKey,
			kind
		},
		generation
	});
	state.schedulerJobsByPlugin.set(params.pluginId, jobs);
	return {
		id,
		pluginId: params.pluginId,
		sessionKey,
		kind
	};
}
function deletePluginSessionSchedulerJob(params) {
	const state = getPluginHostRuntimeState();
	const jobs = state.schedulerJobsByPlugin.get(params.pluginId);
	const record = jobs?.get(params.jobId);
	if (!jobs || !record) return;
	if (params.sessionKey && record.job.sessionKey !== params.sessionKey) return;
	if (params.expectedGeneration !== void 0 && record.generation !== params.expectedGeneration) return;
	jobs.delete(params.jobId);
	if (jobs.size === 0) state.schedulerJobsByPlugin.delete(params.pluginId);
}
function hasPluginSessionSchedulerJob(params) {
	const record = getPluginHostRuntimeState().schedulerJobsByPlugin.get(params.pluginId)?.get(params.jobId);
	if (!record) return false;
	if (params.sessionKey && record.job.sessionKey !== params.sessionKey) return false;
	return params.generation === void 0 || record.generation === params.generation;
}
function getPluginSessionSchedulerJobGeneration(params) {
	const record = getPluginHostRuntimeState().schedulerJobsByPlugin.get(params.pluginId)?.get(params.jobId);
	if (!record) return;
	if (params.sessionKey && record.job.sessionKey !== params.sessionKey) return;
	return record.generation;
}
async function cleanupPluginSessionSchedulerJobs(params) {
	const state = getPluginHostRuntimeState();
	const failures = [];
	if (params.records) {
		for (const record of params.records) {
			if (params.pluginId && record.pluginId !== params.pluginId) continue;
			const jobId = normalizeOptionalString(record.job.id);
			const sessionKey = normalizeOptionalString(record.job.sessionKey);
			if (!jobId || !sessionKey) continue;
			if (params.sessionKey && sessionKey !== params.sessionKey) continue;
			const liveGeneration = getPluginSessionSchedulerJobGeneration({
				pluginId: record.pluginId,
				jobId,
				sessionKey
			});
			if (record.generation !== void 0 && liveGeneration === void 0) continue;
			if (record.generation === void 0 && !hasPluginSessionSchedulerJob({
				pluginId: record.pluginId,
				jobId,
				sessionKey
			})) continue;
			if ((params.preserveJobIds?.has(jobId) ?? false) && (record.generation === void 0 || liveGeneration === record.generation)) continue;
			try {
				await record.job.cleanup?.({
					reason: params.reason,
					sessionKey,
					jobId
				});
			} catch (error) {
				failures.push({
					pluginId: record.pluginId,
					hookId: `scheduler:${jobId}`,
					error
				});
				continue;
			}
			deletePluginSessionSchedulerJob({
				pluginId: record.pluginId,
				jobId,
				sessionKey,
				expectedGeneration: record.generation
			});
		}
		return failures;
	}
	const pluginIds = params.pluginId ? [params.pluginId] : [...state.schedulerJobsByPlugin.keys()];
	for (const pluginId of pluginIds) {
		const jobs = state.schedulerJobsByPlugin.get(pluginId);
		if (!jobs) continue;
		for (const [jobId, record] of jobs.entries()) {
			if (params.sessionKey && record.job.sessionKey !== params.sessionKey) continue;
			try {
				await record.job.cleanup?.({
					reason: params.reason,
					sessionKey: record.job.sessionKey,
					jobId
				});
			} catch (error) {
				failures.push({
					pluginId,
					hookId: `scheduler:${jobId}`,
					error
				});
				continue;
			}
			jobs.delete(jobId);
		}
		if (jobs.size === 0) state.schedulerJobsByPlugin.delete(pluginId);
	}
	return failures;
}
function clearPluginHostRuntimeState(params) {
	clearPluginRunContext(params ?? {});
	if (params?.pluginId) getPluginHostRuntimeState().schedulerJobsByPlugin.delete(params.pluginId);
	else if (!params?.runId) {
		const state = getPluginHostRuntimeState();
		state.schedulerJobsByPlugin.clear();
		state.pendingAgentEventHandlersByRunId.clear();
		state.closedRunIds.clear();
	}
}
//#endregion
export { getPluginRunContext as a, setPluginRunContext as c, isPluginJsonValue as d, dispatchPluginAgentEventSubscriptions as i, buildPluginAgentTurnPrepareContext as l, clearPluginHostRuntimeState as n, getPluginSessionSchedulerJobGeneration as o, clearPluginRunContext as r, registerPluginSessionSchedulerJob as s, cleanupPluginSessionSchedulerJobs as t, normalizePluginHostHookId as u };
