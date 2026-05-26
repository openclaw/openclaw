import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { t as createLazyImportLoader } from "./lazy-promise-Djskx0qC.js";
import { d as resolveAgentIdFromSessionKey } from "./session-key-Bte0mmcq.js";
import "./defaults-mDjiWzE5.js";
import { a as resolveSessionFilePathOptions, i as resolveSessionFilePath } from "./paths-Bg3PO6Gj.js";
import { u as updateSessionStore } from "./store-BmtchQvp.js";
import { n as mergeSessionEntry, u as setSessionRuntimeModel } from "./types-BgvyBC-3.js";
import { a as canonicalizeAbsoluteSessionFilePath, o as rewriteSessionFileForNewSessionId } from "./sessions-CQHHcgC_.js";
import { t as isCliProvider } from "./model-selection-cli-DS-HhXIv.js";
import "./model-selection-P-81eBKx.js";
import { i as hasNonzeroUsage, r as deriveSessionTotalTokens } from "./usage-DKNTRfvn.js";
import { c as setCliSessionId, n as clearCliSession, s as setCliSessionBinding } from "./cli-session-FftCLDUT.js";
import path from "node:path";
//#region src/agents/command/session-store.ts
const usageFormatModuleLoader = createLazyImportLoader(() => import("./usage-format-DOZpqb2o.js"));
const contextModuleLoader = createLazyImportLoader(() => import("./context-DCd2igxH.js"));
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
	const lastCallUsage = result.meta.agentMeta?.lastCallUsage;
	const compactionTokensAfter = typeof result.meta.agentMeta?.compactionTokensAfter === "number" && Number.isFinite(result.meta.agentMeta.compactionTokensAfter) && result.meta.agentMeta.compactionTokensAfter >= 0 ? Math.floor(result.meta.agentMeta.compactionTokensAfter) : void 0;
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
	const preserveRuntimeModel = params.preserveRuntimeModel === true;
	const entry = sessionStore[sessionKey] ?? {
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
		const usageForContext = isCliProvider(providerUsed, cfg) ? promptTokens ? void 0 : lastCallUsage : usage;
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
	sessionStore[sessionKey] = await updateSessionStore(storePath, (store) => {
		const merged = mergeSessionEntry(store[sessionKey], metadataPatch);
		store[sessionKey] = merged;
		return merged;
	});
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
	const newSessionId = normalizeOptionalString(params.newSessionId);
	const explicitNewSessionFile = normalizeOptionalString(params.newSessionFile);
	const sessionIdChanged = Boolean(newSessionId && newSessionId !== entry.sessionId);
	const sessionFileChanged = Boolean(explicitNewSessionFile && explicitNewSessionFile !== entry.sessionFile);
	if (sessionIdChanged && newSessionId) {
		next.sessionId = newSessionId;
		next.sessionFile = explicitNewSessionFile ?? resolveCompactionSessionFile({
			entry,
			sessionKey,
			storePath,
			newSessionId
		});
		next.usageFamilyKey = entry.usageFamilyKey ?? sessionKey;
		next.usageFamilySessionIds = Array.from(new Set([
			...entry.usageFamilySessionIds ?? [],
			entry.sessionId,
			newSessionId
		]));
	} else if (sessionFileChanged && explicitNewSessionFile) next.sessionFile = explicitNewSessionFile;
	const tokensAfterCompaction = resolveNonNegativeNumber(params.tokensAfter);
	if (tokensAfterCompaction !== void 0) {
		next.totalTokens = Math.floor(tokensAfterCompaction);
		next.totalTokensFresh = true;
		next.inputTokens = void 0;
		next.outputTokens = void 0;
		next.cacheRead = void 0;
		next.cacheWrite = void 0;
	} else {
		next.totalTokensFresh = false;
		next.inputTokens = void 0;
		next.outputTokens = void 0;
		next.cacheRead = void 0;
		next.cacheWrite = void 0;
	}
	const persisted = await updateSessionStore(storePath, (store) => {
		const merged = mergeSessionEntry(store[sessionKey], next);
		store[sessionKey] = merged;
		return merged;
	});
	sessionStore[sessionKey] = persisted;
	return persisted;
}
function resolveCompactionSessionFile(params) {
	const pathOpts = resolveSessionFilePathOptions({
		agentId: resolveAgentIdFromSessionKey(params.sessionKey),
		storePath: params.storePath
	});
	const rewrittenSessionFile = rewriteSessionFileForNewSessionId({
		sessionFile: params.entry.sessionFile,
		previousSessionId: params.entry.sessionId,
		nextSessionId: params.newSessionId
	});
	const normalizedRewrittenSessionFile = rewrittenSessionFile && path.isAbsolute(rewrittenSessionFile) ? canonicalizeAbsoluteSessionFilePath(rewrittenSessionFile) : rewrittenSessionFile;
	return resolveSessionFilePath(params.newSessionId, normalizedRewrittenSessionFile ? { sessionFile: normalizedRewrittenSessionFile } : void 0, pathOpts);
}
//#endregion
export { recordCliCompactionInStore as n, updateSessionStoreAfterAgentRun as r, clearCliSessionInStore as t };
