import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
import { t as createLazyImportLoader } from "./lazy-promise-BWWZqHu4.js";
import "./defaults-CHyQiMS4.js";
import { n as mergeSessionEntry, u as setSessionRuntimeModel } from "./types-CuAWZ88l.js";
import { o as updateSessionStore, p as resolveSessionStoreEntry } from "./store-IyLBOjUO.js";
import "./sessions-DCQidobb.js";
import { t as isCliProvider } from "./model-selection-cli-SCVmnYbl.js";
import "./model-selection-aDhlumjq.js";
import { i as hasNonzeroUsage, r as deriveSessionTotalTokens } from "./usage-Bn9PFA_4.js";
import { c as setCliSessionId, n as clearCliSession, s as setCliSessionBinding } from "./cli-session-BQkJpEy_.js";
//#region src/agents/command/session-store.ts
const usageFormatModuleLoader = createLazyImportLoader(() => import("./usage-format-DNjnRSfa.js"));
const contextModuleLoader = createLazyImportLoader(() => import("./context-BhahclNt.js"));
async function getUsageFormatModule() {
	return await usageFormatModuleLoader.load();
}
async function getContextModule() {
	return await contextModuleLoader.load();
}
function resolveNonNegativeNumber(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : void 0;
}
function resolvePositiveInteger(value) {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return;
	return Math.floor(value);
}
function removeLifecycleStateFromMetadataPatch(entry) {
	const next = { ...entry };
	delete next.status;
	delete next.startedAt;
	delete next.endedAt;
	delete next.runtimeMs;
	return next;
}
async function updateSessionStoreAfterAgentRun(params) {
	const { cfg, sessionId, sessionKey, storePath, sessionStore, defaultProvider, defaultModel, fallbackProvider, fallbackModel, result } = params;
	const now = Date.now();
	const touchInteraction = params.touchInteraction !== false;
	const usage = result.meta.agentMeta?.usage;
	const promptTokens = result.meta.agentMeta?.promptTokens;
	const compactionTokensAfter = typeof result.meta.agentMeta?.compactionTokensAfter === "number" && Number.isFinite(result.meta.agentMeta.compactionTokensAfter) && result.meta.agentMeta.compactionTokensAfter > 0 ? Math.floor(result.meta.agentMeta.compactionTokensAfter) : void 0;
	const compactionsThisRun = Math.max(0, result.meta.agentMeta?.compactionCount ?? 0);
	const modelUsed = result.meta.agentMeta?.model ?? fallbackModel ?? defaultModel;
	const providerUsed = result.meta.agentMeta?.provider ?? fallbackProvider ?? defaultProvider;
	const agentHarnessId = normalizeOptionalString(result.meta.agentMeta?.agentHarnessId);
	const runtimeContextTokens = resolvePositiveInteger(result.meta.agentMeta?.contextTokens);
	const contextTokens = runtimeContextTokens !== void 0 ? runtimeContextTokens : typeof params.contextTokensOverride === "number" && params.contextTokensOverride > 0 ? params.contextTokensOverride : (await getContextModule()).resolveContextTokensForModel({
		cfg,
		provider: providerUsed,
		model: modelUsed,
		fallbackContextTokens: 2e5,
		allowAsyncLoad: false
	}) ?? 2e5;
	const memResolved = resolveSessionStoreEntry({
		store: sessionStore,
		sessionKey
	});
	const preserveRuntimeModel = params.preserveRuntimeModel === true;
	const entry = memResolved.existing ?? {
		sessionId,
		updatedAt: now,
		sessionStartedAt: now
	};
	const next = {
		...entry,
		sessionId,
		updatedAt: now,
		sessionStartedAt: entry.sessionId === sessionId ? entry.sessionStartedAt ?? now : now,
		lastInteractionAt: touchInteraction ? now : entry.lastInteractionAt,
		...preserveRuntimeModel ? {} : { contextTokens }
	};
	if (preserveRuntimeModel) {
		if (entry.model) {
			next.contextTokens = entry.contextTokens;
			if (entry.modelProvider) setSessionRuntimeModel(next, {
				provider: entry.modelProvider,
				model: entry.model
			});
			else next.model = entry.model;
		}
	} else setSessionRuntimeModel(next, {
		provider: providerUsed,
		model: modelUsed
	});
	if (agentHarnessId) next.agentHarnessId = agentHarnessId;
	else if (result.meta.executionTrace?.runner === "cli") next.agentHarnessId = void 0;
	if (isCliProvider(providerUsed, cfg)) {
		const cliSessionBinding = result.meta.agentMeta?.cliSessionBinding;
		if (cliSessionBinding?.sessionId?.trim()) setCliSessionBinding(next, providerUsed, cliSessionBinding);
		else {
			const cliSessionId = result.meta.agentMeta?.sessionId?.trim();
			if (cliSessionId) setCliSessionId(next, providerUsed, cliSessionId);
		}
	}
	next.abortedLastRun = result.meta.aborted ?? false;
	if (result.meta.systemPromptReport) next.systemPromptReport = result.meta.systemPromptReport;
	if (hasNonzeroUsage(usage)) {
		const { estimateUsageCost, resolveModelCostConfig } = await getUsageFormatModule();
		const input = usage.input ?? 0;
		const output = usage.output ?? 0;
		const usageForContext = isCliProvider(providerUsed, cfg) ? void 0 : usage;
		const totalTokens = deriveSessionTotalTokens({
			usage: promptTokens ? void 0 : usageForContext,
			contextTokens,
			promptTokens
		});
		const runEstimatedCostUsd = resolveNonNegativeNumber(estimateUsageCost({
			usage,
			cost: resolveModelCostConfig({
				provider: providerUsed,
				model: modelUsed,
				config: cfg
			})
		}));
		next.inputTokens = input;
		next.outputTokens = output;
		if (typeof totalTokens === "number" && Number.isFinite(totalTokens) && totalTokens > 0) {
			next.totalTokens = totalTokens;
			next.totalTokensFresh = true;
		} else if (compactionTokensAfter !== void 0) {
			next.totalTokens = compactionTokensAfter;
			next.totalTokensFresh = true;
		} else {
			next.totalTokens = void 0;
			next.totalTokensFresh = false;
		}
		next.cacheRead = usage.cacheRead ?? 0;
		next.cacheWrite = usage.cacheWrite ?? 0;
		if (runEstimatedCostUsd !== void 0) next.estimatedCostUsd = runEstimatedCostUsd;
	} else if (compactionTokensAfter !== void 0) {
		next.totalTokens = compactionTokensAfter;
		next.totalTokensFresh = true;
	} else if (typeof entry.totalTokens === "number" && Number.isFinite(entry.totalTokens) && entry.totalTokens > 0) {
		next.totalTokens = entry.totalTokens;
		next.totalTokensFresh = false;
	}
	if (compactionsThisRun > 0) next.compactionCount = (entry.compactionCount ?? 0) + compactionsThisRun;
	const metadataPatch = removeLifecycleStateFromMetadataPatch(next);
	const persisted = await updateSessionStore(storePath, (store) => {
		const resolved = resolveSessionStoreEntry({
			store,
			sessionKey
		});
		const merged = mergeSessionEntry(resolved.existing, metadataPatch);
		store[resolved.normalizedKey] = merged;
		for (const legacyKey of resolved.legacyKeys) delete store[legacyKey];
		return merged;
	});
	sessionStore[memResolved.normalizedKey] = persisted;
	for (const legacyKey of memResolved.legacyKeys) delete sessionStore[legacyKey];
}
async function clearCliSessionInStore(params) {
	const { provider, sessionKey, sessionStore, storePath } = params;
	const entry = sessionStore[sessionKey];
	if (!entry) return;
	const next = { ...entry };
	clearCliSession(next, provider);
	next.updatedAt = Date.now();
	const persisted = await updateSessionStore(storePath, (store) => {
		const merged = mergeSessionEntry(store[sessionKey], next);
		store[sessionKey] = merged;
		return merged;
	});
	sessionStore[sessionKey] = persisted;
	return persisted;
}
async function recordCliCompactionInStore(params) {
	const { provider, sessionKey, sessionStore, storePath } = params;
	const entry = sessionStore[sessionKey];
	if (!entry) return;
	const next = { ...entry };
	clearCliSession(next, provider);
	next.compactionCount = (entry.compactionCount ?? 0) + 1;
	next.updatedAt = Date.now();
	const persisted = await updateSessionStore(storePath, (store) => {
		const merged = mergeSessionEntry(store[sessionKey], next);
		store[sessionKey] = merged;
		return merged;
	});
	sessionStore[sessionKey] = persisted;
	return persisted;
}
//#endregion
export { recordCliCompactionInStore as n, updateSessionStoreAfterAgentRun as r, clearCliSessionInStore as t };
