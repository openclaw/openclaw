import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { r as theme } from "./theme-D58JpUfy.js";
import { i as resolveAgentModelPrimaryValue } from "./model-input-ChW9XXsQ.js";
import { n as DEFAULT_MODEL, r as DEFAULT_PROVIDER } from "./defaults-mDjiWzE5.js";
import { a as resolveSessionStoreTargets } from "./targets-B5o7Ubgb.js";
import "./sessions-CQHHcgC_.js";
import { l as inferUniqueProviderFromConfiguredModels } from "./model-selection-shared-ClxdEp4X.js";
import { t as isCliProvider } from "./model-selection-cli-DS-HhXIv.js";
import "./model-selection-P-81eBKx.js";
import { n as formatTimeAgo } from "./format-relative-Bjc3l98W.js";
//#region src/commands/session-store-targets.ts
function resolveSessionStoreTargetsOrExit(params) {
	try {
		return resolveSessionStoreTargets(params.cfg, params.opts);
	} catch (error) {
		params.runtime.error(formatErrorMessage(error));
		params.runtime.exit(1);
		return null;
	}
}
//#endregion
//#region src/commands/sessions-display-model.ts
function parseModelRef(raw, defaultProvider) {
	const trimmed = raw.trim();
	if (!trimmed) return {
		provider: defaultProvider,
		model: DEFAULT_MODEL
	};
	const slashIndex = trimmed.indexOf("/");
	if (slashIndex <= 0 || slashIndex === trimmed.length - 1) return {
		provider: defaultProvider,
		model: trimmed
	};
	return {
		provider: trimmed.slice(0, slashIndex).trim() || defaultProvider,
		model: trimmed.slice(slashIndex + 1).trim() || "gpt-5.5"
	};
}
function resolveAgentPrimaryModel(cfg, agentId) {
	if (!agentId) return;
	const agentConfig = cfg.agents?.list?.find((agent) => agent.id === agentId);
	return resolveAgentModelPrimaryValue(agentConfig?.model);
}
function normalizeStoredOverrideModel(params) {
	const providerOverride = params.providerOverride?.trim();
	const modelOverride = params.modelOverride?.trim();
	if (!providerOverride || !modelOverride) return {
		providerOverride,
		modelOverride
	};
	const providerPrefix = `${providerOverride.toLowerCase()}/`;
	return {
		providerOverride,
		modelOverride: modelOverride.toLowerCase().startsWith(providerPrefix) ? modelOverride.slice(providerOverride.length + 1).trim() || modelOverride : modelOverride
	};
}
function resolveDefaultModelRef(cfg, agentId) {
	return parseModelRef(resolveAgentPrimaryModel(cfg, agentId) ?? resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model) ?? "gpt-5.5", DEFAULT_PROVIDER);
}
function resolveSessionDisplayDefaults(cfg, agentId) {
	return { model: resolveDefaultModelRef(cfg, agentId).model };
}
function normalizeCliRuntimeDisplayRef(cfg, ref, defaultRef) {
	if (!isCliProvider(ref.provider, cfg)) return ref;
	if (ref.model.includes("/")) {
		const parsed = parseModelRef(ref.model, defaultRef.provider);
		if (!isCliProvider(parsed.provider, cfg)) return parsed;
	}
	const inferredProvider = inferUniqueProviderFromConfiguredModels({
		cfg,
		model: ref.model
	});
	if (inferredProvider && !isCliProvider(inferredProvider, cfg)) return {
		provider: inferredProvider,
		model: ref.model
	};
	const parsed = parseModelRef(ref.model, defaultRef.provider);
	if (!isCliProvider(parsed.provider, cfg)) return parsed;
	return {
		provider: defaultRef.provider || ref.provider,
		model: parsed.model || ref.model
	};
}
function resolveSessionDisplayModel(cfg, row) {
	return resolveSessionDisplayModelRef(cfg, row).model;
}
function resolveSessionDisplayModelRef(cfg, row) {
	const defaultRef = resolveDefaultModelRef(cfg, row.key.startsWith("agent:") ? row.key.split(":")[1] : void 0);
	const normalizedOverride = normalizeStoredOverrideModel({
		providerOverride: row.providerOverride,
		modelOverride: row.modelOverride
	});
	if (normalizedOverride.modelOverride) return parseModelRef(normalizedOverride.modelOverride, normalizedOverride.providerOverride ?? defaultRef.provider);
	if (row.model) return normalizeCliRuntimeDisplayRef(cfg, parseModelRef(row.model, row.modelProvider ?? defaultRef.provider), defaultRef);
	return defaultRef;
}
function toSessionDisplayRow(key, entry) {
	const updatedAt = entry?.updatedAt ?? null;
	return {
		key,
		updatedAt,
		ageMs: updatedAt ? Date.now() - updatedAt : null,
		sessionId: entry?.sessionId,
		systemSent: entry?.systemSent,
		abortedLastRun: entry?.abortedLastRun,
		thinkingLevel: entry?.thinkingLevel,
		verboseLevel: entry?.verboseLevel,
		traceLevel: entry?.traceLevel,
		reasoningLevel: entry?.reasoningLevel,
		elevatedLevel: entry?.elevatedLevel,
		responseUsage: entry?.responseUsage,
		groupActivation: entry?.groupActivation,
		inputTokens: entry?.inputTokens,
		outputTokens: entry?.outputTokens,
		totalTokens: entry?.totalTokens,
		totalTokensFresh: entry?.totalTokensFresh,
		model: entry?.model,
		modelProvider: entry?.modelProvider,
		providerOverride: entry?.providerOverride,
		modelOverride: entry?.modelOverride,
		contextTokens: entry?.contextTokens
	};
}
function toSessionDisplayRows(store) {
	return Object.entries(store).map(([key, entry]) => toSessionDisplayRow(key, entry)).toSorted((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}
function truncateSessionKey(key) {
	if (key.length <= 26) return key;
	const head = Math.max(4, 16);
	return `${key.slice(0, head)}...${key.slice(-6)}`;
}
function formatSessionKeyCell(key, rich) {
	const label = truncateSessionKey(key).padEnd(26);
	return rich ? theme.accent(label) : label;
}
function formatSessionAgeCell(updatedAt, rich) {
	const padded = (updatedAt ? formatTimeAgo(Date.now() - updatedAt) : "unknown").padEnd(9);
	return rich ? theme.muted(padded) : padded;
}
function formatSessionModelCell(model, rich) {
	const label = (model ?? "unknown").padEnd(14);
	return rich ? theme.info(label) : label;
}
function formatSessionFlagsCell(row, rich) {
	const label = [
		row.thinkingLevel ? `think:${row.thinkingLevel}` : null,
		row.verboseLevel ? `verbose:${row.verboseLevel}` : null,
		row.traceLevel ? `trace:${row.traceLevel}` : null,
		row.reasoningLevel ? `reasoning:${row.reasoningLevel}` : null,
		row.elevatedLevel ? `elev:${row.elevatedLevel}` : null,
		row.responseUsage ? `usage:${row.responseUsage}` : null,
		row.groupActivation ? `activation:${row.groupActivation}` : null,
		row.systemSent ? "system" : null,
		row.abortedLastRun ? "aborted" : null,
		row.runtimePolicySessionKey ? `policy:${row.runtimePolicySessionKey}` : null,
		row.sessionId ? `id:${row.sessionId}` : null
	].filter(Boolean).join(" ");
	return label.length === 0 ? "" : rich ? theme.muted(label) : label;
}
//#endregion
export { toSessionDisplayRow as a, resolveSessionDisplayModel as c, formatSessionModelCell as i, resolveSessionDisplayModelRef as l, formatSessionFlagsCell as n, toSessionDisplayRows as o, formatSessionKeyCell as r, resolveSessionDisplayDefaults as s, formatSessionAgeCell as t, resolveSessionStoreTargetsOrExit as u };
