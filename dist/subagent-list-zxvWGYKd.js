import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { o as parseAgentSessionKey } from "./session-key-utils-qD-NZHCY.js";
import { u as resolveStorePath } from "./paths-kGAxo7MN.js";
import { t as loadSessionStore } from "./store-load-cmAGD4uk.js";
import { t as formatDurationCompact } from "./format-duration-q-bulWEj.js";
import { S as getSubagentSessionStartedAt, _ as hasSubagentRunEnded, a as countActiveDescendantRunsFromRuns, b as shouldKeepSubagentRunChildLink, c as countPendingDescendantRunsFromRuns, j as subagentRuns, t as getSubagentRunsSnapshotForRead, v as isLiveUnendedSubagentRun, x as getSubagentSessionRuntimeMs } from "./subagent-registry-state-DKEodHtB.js";
import "./subagent-registry-read-CUpdXOkd.js";
import { a as sortSubagentRuns, r as resolveSubagentLabel } from "./subagents-utils-7qcyKqvL.js";
import { n as resolveTotalTokens, r as truncateLine, t as formatTokenUsageDisplay } from "./subagents-format-NO7BQg0E.js";
//#region src/agents/model-selection-display.ts
function resolveModelDisplayRef(params) {
	const runtimeModel = normalizeOptionalString(params.runtimeModel);
	const runtimeProvider = normalizeOptionalString(params.runtimeProvider);
	if (runtimeModel) {
		if (runtimeModel.includes("/")) return runtimeModel;
		if (runtimeProvider) return `${runtimeProvider}/${runtimeModel}`;
		return runtimeModel;
	}
	if (runtimeProvider) return runtimeProvider;
	const overrideModel = normalizeOptionalString(params.overrideModel);
	const overrideProvider = normalizeOptionalString(params.overrideProvider);
	if (overrideModel) {
		if (overrideModel.includes("/")) return overrideModel;
		if (overrideProvider) return `${overrideProvider}/${overrideModel}`;
		return overrideModel;
	}
	if (overrideProvider) return overrideProvider;
	return normalizeOptionalString(params.fallbackModel) || void 0;
}
function resolveModelDisplayName(params) {
	const modelRef = resolveModelDisplayRef(params);
	if (!modelRef) return "model n/a";
	const slash = modelRef.lastIndexOf("/");
	if (slash >= 0 && slash < modelRef.length - 1) return modelRef.slice(slash + 1);
	return modelRef;
}
function resolveSessionInfoModelSelection(params) {
	const fallbackProvider = normalizeOptionalString(params.currentProvider) ?? normalizeOptionalString(params.defaultProvider) ?? void 0;
	const fallbackModel = normalizeOptionalString(params.currentModel) ?? normalizeOptionalString(params.defaultModel) ?? void 0;
	if (params.entryProvider !== void 0 || params.entryModel !== void 0) return {
		modelProvider: normalizeOptionalString(params.entryProvider) ?? fallbackProvider,
		model: normalizeOptionalString(params.entryModel) ?? fallbackModel
	};
	const overrideModel = normalizeOptionalString(params.overrideModel);
	if (overrideModel) return {
		modelProvider: normalizeOptionalString(params.overrideProvider) || fallbackProvider,
		model: overrideModel
	};
	return {
		modelProvider: fallbackProvider,
		model: fallbackModel
	};
}
//#endregion
//#region src/agents/subagent-list.ts
function resolveStorePathForKey(cfg, parsed) {
	return resolveStorePath(cfg.session?.store, { agentId: parsed?.agentId });
}
function resolveSessionEntryForKey(params) {
	const parsed = parseAgentSessionKey(params.key);
	const storePath = resolveStorePathForKey(params.cfg, parsed);
	let store = params.cache.get(storePath);
	if (!store) {
		store = loadSessionStore(storePath);
		params.cache.set(storePath, store);
	}
	return {
		storePath,
		entry: store[params.key]
	};
}
function buildLatestSubagentRunIndex(runs, options) {
	const now = options?.now ?? Date.now();
	const latestByChildSessionKey = /* @__PURE__ */ new Map();
	for (const entry of runs.values()) {
		const childSessionKey = entry.childSessionKey?.trim();
		if (!childSessionKey) continue;
		const existing = latestByChildSessionKey.get(childSessionKey);
		if (!existing || entry.createdAt > existing.createdAt) latestByChildSessionKey.set(childSessionKey, entry);
	}
	const childSessionsByController = /* @__PURE__ */ new Map();
	for (const [childSessionKey, entry] of latestByChildSessionKey.entries()) {
		const controllerSessionKey = entry.controllerSessionKey?.trim() || entry.requesterSessionKey?.trim();
		if (!controllerSessionKey) continue;
		if (!shouldKeepSubagentRunChildLink(entry, {
			activeDescendants: countActiveDescendantRunsFromRuns(runs, childSessionKey),
			now
		})) continue;
		const existing = childSessionsByController.get(controllerSessionKey);
		if (existing) {
			existing.push(childSessionKey);
			continue;
		}
		childSessionsByController.set(controllerSessionKey, [childSessionKey]);
	}
	for (const [controllerSessionKey, childSessions] of childSessionsByController) childSessionsByController.set(controllerSessionKey, childSessions.toSorted());
	return {
		latestByChildSessionKey,
		childSessionsByController
	};
}
function createPendingDescendantCounter(runsSnapshot) {
	const pendingDescendantCache = /* @__PURE__ */ new Map();
	return (sessionKey) => {
		if (pendingDescendantCache.has(sessionKey)) return pendingDescendantCache.get(sessionKey) ?? 0;
		const snapshot = runsSnapshot ?? getSubagentRunsSnapshotForRead(subagentRuns);
		const pending = Math.max(0, countPendingDescendantRunsFromRuns(snapshot, sessionKey));
		pendingDescendantCache.set(sessionKey, pending);
		return pending;
	};
}
function isActiveSubagentRun(entry, pendingDescendantCount) {
	return isLiveUnendedSubagentRun(entry) || pendingDescendantCount(entry.childSessionKey) > 0;
}
function resolveRunStatus(entry, options) {
	const pendingDescendants = Math.max(0, options?.pendingDescendants ?? 0);
	if (pendingDescendants > 0) return `active (waiting on ${pendingDescendants} ${pendingDescendants === 1 ? "child" : "children"})`;
	if (!hasSubagentRunEnded(entry)) return "running";
	const status = entry.outcome?.status ?? "done";
	if (status === "ok") return "done";
	if (status === "error") return "failed";
	return status;
}
function resolveModelRef(entry, fallbackModel) {
	return resolveModelDisplayRef({
		runtimeProvider: entry?.modelProvider,
		runtimeModel: entry?.model,
		overrideProvider: entry?.providerOverride,
		overrideModel: entry?.modelOverride,
		fallbackModel
	});
}
function resolveModelDisplay(entry, fallbackModel) {
	return resolveModelDisplayName({
		runtimeProvider: entry?.modelProvider,
		runtimeModel: entry?.model,
		overrideProvider: entry?.providerOverride,
		overrideModel: entry?.modelOverride,
		fallbackModel
	});
}
function buildListText(params) {
	const lines = [];
	lines.push("active subagents:");
	if (params.active.length === 0) lines.push("(none)");
	else lines.push(...params.active.map((entry) => entry.line));
	lines.push("");
	lines.push(`recent (last ${params.recentMinutes}m):`);
	if (params.recent.length === 0) lines.push("(none)");
	else lines.push(...params.recent.map((entry) => entry.line));
	return lines.join("\n");
}
function buildSubagentList(params) {
	const now = Date.now();
	const recentCutoff = now - params.recentMinutes * 6e4;
	const dedupedRuns = [];
	const seenChildSessionKeys = /* @__PURE__ */ new Set();
	for (const entry of sortSubagentRuns(params.runs)) {
		if (seenChildSessionKeys.has(entry.childSessionKey)) continue;
		seenChildSessionKeys.add(entry.childSessionKey);
		dedupedRuns.push(entry);
	}
	const cache = /* @__PURE__ */ new Map();
	const snapshot = getSubagentRunsSnapshotForRead(subagentRuns);
	const { childSessionsByController } = buildLatestSubagentRunIndex(snapshot);
	const pendingDescendantCount = createPendingDescendantCounter(snapshot);
	let index = 1;
	const buildListEntry = (entry, runtimeMs) => {
		const sessionEntry = resolveSessionEntryForKey({
			cfg: params.cfg,
			key: entry.childSessionKey,
			cache
		}).entry;
		const totalTokens = resolveTotalTokens(sessionEntry);
		const usageText = formatTokenUsageDisplay(sessionEntry);
		const pendingDescendants = pendingDescendantCount(entry.childSessionKey);
		const status = resolveRunStatus(entry, { pendingDescendants });
		const childSessions = childSessionsByController.get(entry.childSessionKey) ?? [];
		const runtime = formatDurationCompact(runtimeMs) ?? "n/a";
		const label = truncateLine(resolveSubagentLabel(entry), 48);
		const task = truncateLine(entry.task.trim(), params.taskMaxChars ?? 72);
		const taskName = entry.taskName?.trim();
		const taskNamePrefix = taskName ? `${taskName}: ` : "";
		const line = `${index}. ${taskNamePrefix}${label} (${resolveModelDisplay(sessionEntry, entry.model)}, ${runtime}${usageText ? `, ${usageText}` : ""}) ${status}${normalizeLowercaseStringOrEmpty(task) !== normalizeLowercaseStringOrEmpty(label) ? ` - ${task}` : ""}`;
		const view = {
			index,
			line,
			runId: entry.runId,
			sessionKey: entry.childSessionKey,
			...taskName ? { taskName } : {},
			label,
			task,
			status,
			pendingDescendants,
			runtime,
			runtimeMs,
			...childSessions.length > 0 ? { childSessions } : {},
			model: resolveModelRef(sessionEntry, entry.model),
			totalTokens,
			startedAt: getSubagentSessionStartedAt(entry),
			...entry.endedAt ? { endedAt: entry.endedAt } : {}
		};
		index += 1;
		return view;
	};
	const active = dedupedRuns.filter((entry) => isActiveSubagentRun(entry, pendingDescendantCount)).map((entry) => buildListEntry(entry, getSubagentSessionRuntimeMs(entry, now) ?? 0));
	const recent = dedupedRuns.filter((entry) => !isActiveSubagentRun(entry, pendingDescendantCount) && !!entry.endedAt && (entry.endedAt ?? 0) >= recentCutoff).map((entry) => buildListEntry(entry, getSubagentSessionRuntimeMs(entry, entry.endedAt ?? now) ?? 0));
	return {
		total: dedupedRuns.length,
		active,
		recent,
		text: buildListText({
			active,
			recent,
			recentMinutes: params.recentMinutes
		})
	};
}
//#endregion
export { resolveSessionEntryForKey as a, isActiveSubagentRun as i, buildSubagentList as n, resolveSessionInfoModelSelection as o, createPendingDescendantCounter as r, buildLatestSubagentRunIndex as t };
