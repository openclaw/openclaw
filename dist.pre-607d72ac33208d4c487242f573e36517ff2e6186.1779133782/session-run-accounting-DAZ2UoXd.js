import { r as logVerbose } from "./globals-DaPK6X5S.js";
import { i as getRuntimeConfig } from "./io-DxVmbF3R.js";
import "./config-CBeYX-pH.js";
import { c as updateSessionStoreEntry } from "./store-DM2Qj4Ie.js";
import "./sessions-Buwioyq3.js";
import { a as resolveModelCostConfig, t as estimateUsageCost } from "./usage-format-DHbNvfsm.js";
import { i as hasNonzeroUsage, r as deriveSessionTotalTokens } from "./usage-BK25y-g_.js";
import { c as setCliSessionId, s as setCliSessionBinding } from "./cli-session-BKce9Zm1.js";
import { n as incrementCompactionCount } from "./session-updates-4WHiVGQd.js";
//#region src/auto-reply/reply/session-usage.ts
function applyCliSessionIdToSessionPatch(params, entry, patch) {
	const cliProvider = params.providerUsed ?? entry.modelProvider;
	if (params.cliSessionBinding && cliProvider) {
		const nextEntry = {
			...entry,
			...patch
		};
		setCliSessionBinding(nextEntry, cliProvider, params.cliSessionBinding);
		return {
			...patch,
			cliSessionIds: nextEntry.cliSessionIds,
			cliSessionBindings: nextEntry.cliSessionBindings,
			claudeCliSessionId: nextEntry.claudeCliSessionId
		};
	}
	if (params.cliSessionId && cliProvider) {
		const nextEntry = {
			...entry,
			...patch
		};
		setCliSessionId(nextEntry, cliProvider, params.cliSessionId);
		return {
			...patch,
			cliSessionIds: nextEntry.cliSessionIds,
			cliSessionBindings: nextEntry.cliSessionBindings,
			claudeCliSessionId: nextEntry.claudeCliSessionId
		};
	}
	return patch;
}
function resolveNonNegativeNumber(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : void 0;
}
function estimateSessionRunCostUsd(params) {
	if (!hasNonzeroUsage(params.usage)) return;
	const cost = resolveModelCostConfig({
		provider: params.providerUsed,
		model: params.modelUsed,
		config: params.cfg
	});
	return resolveNonNegativeNumber(estimateUsageCost({
		usage: params.usage,
		cost
	}));
}
async function persistSessionUsageUpdate(params) {
	const { storePath, sessionKey } = params;
	if (!storePath || !sessionKey) return;
	const label = params.logLabel ? `${params.logLabel} ` : "";
	const cfg = params.cfg ?? getRuntimeConfig();
	const hasUsage = hasNonzeroUsage(params.usage);
	const hasPromptTokens = typeof params.promptTokens === "number" && Number.isFinite(params.promptTokens) && params.promptTokens > 0;
	const hasFreshContextSnapshot = Boolean(params.lastCallUsage) || hasPromptTokens || params.usageIsContextSnapshot === true;
	if (hasUsage || hasFreshContextSnapshot) {
		try {
			await updateSessionStoreEntry({
				storePath,
				sessionKey,
				update: async (entry) => {
					const resolvedContextTokens = params.contextTokensUsed ?? entry.contextTokens;
					const usageForContext = params.lastCallUsage ?? (params.usageIsContextSnapshot === true ? params.usage : void 0);
					const totalTokens = hasFreshContextSnapshot ? deriveSessionTotalTokens({
						usage: usageForContext,
						contextTokens: resolvedContextTokens,
						promptTokens: params.promptTokens
					}) : void 0;
					const runEstimatedCostUsd = estimateSessionRunCostUsd({
						cfg,
						usage: params.usage,
						providerUsed: params.providerUsed ?? entry.modelProvider,
						modelUsed: params.modelUsed ?? entry.model
					});
					const patch = {
						modelProvider: params.isHeartbeat === true ? entry.modelProvider : params.providerUsed ?? entry.modelProvider,
						model: params.isHeartbeat === true ? entry.model : params.modelUsed ?? entry.model,
						contextTokens: resolvedContextTokens,
						systemPromptReport: params.systemPromptReport ?? entry.systemPromptReport,
						updatedAt: Date.now()
					};
					if (hasUsage) {
						patch.inputTokens = params.usage?.input ?? 0;
						patch.outputTokens = params.usage?.output ?? 0;
						const cacheUsage = params.lastCallUsage ?? params.usage;
						patch.cacheRead = cacheUsage?.cacheRead ?? 0;
						patch.cacheWrite = cacheUsage?.cacheWrite ?? 0;
					}
					if (runEstimatedCostUsd !== void 0) patch.estimatedCostUsd = runEstimatedCostUsd;
					if (hasFreshContextSnapshot) {
						patch.totalTokens = totalTokens;
						patch.totalTokensFresh = true;
					} else if (params.preserveFreshTotalTokensOnStaleUsage !== true || entry.totalTokensFresh !== true) patch.totalTokensFresh = false;
					return applyCliSessionIdToSessionPatch(params, entry, patch);
				}
			});
		} catch (err) {
			logVerbose(`failed to persist ${label}usage update: ${String(err)}`);
		}
		return;
	}
	if (params.modelUsed || params.contextTokensUsed) try {
		await updateSessionStoreEntry({
			storePath,
			sessionKey,
			update: async (entry) => {
				return applyCliSessionIdToSessionPatch(params, entry, {
					modelProvider: params.isHeartbeat === true ? entry.modelProvider : params.providerUsed ?? entry.modelProvider,
					model: params.isHeartbeat === true ? entry.model : params.modelUsed ?? entry.model,
					contextTokens: params.contextTokensUsed ?? entry.contextTokens,
					systemPromptReport: params.systemPromptReport ?? entry.systemPromptReport,
					updatedAt: Date.now()
				});
			}
		});
	} catch (err) {
		logVerbose(`failed to persist ${label}model/context update: ${String(err)}`);
	}
}
//#endregion
//#region src/auto-reply/reply/session-run-accounting.ts
function resolvePositiveTokenCount(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : void 0;
}
async function persistRunSessionUsage(params) {
	await persistSessionUsageUpdate(params);
}
async function incrementRunCompactionCount(params) {
	const tokensAfterCompaction = resolvePositiveTokenCount(params.compactionTokensAfter) ?? (params.lastCallUsage ? deriveSessionTotalTokens({
		usage: params.lastCallUsage,
		contextTokens: params.contextTokensUsed
	}) : void 0);
	return incrementCompactionCount({
		sessionEntry: params.sessionEntry,
		sessionStore: params.sessionStore,
		sessionKey: params.sessionKey,
		storePath: params.storePath,
		cfg: params.cfg,
		amount: params.amount,
		tokensAfter: tokensAfterCompaction,
		newSessionId: params.newSessionId,
		newSessionFile: params.newSessionFile
	});
}
//#endregion
export { persistRunSessionUsage as n, incrementRunCompactionCount as t };
