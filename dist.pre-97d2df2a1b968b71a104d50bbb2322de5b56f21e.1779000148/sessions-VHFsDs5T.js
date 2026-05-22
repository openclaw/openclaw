import { s as normalizeOptionalLowercaseString } from "./string-coerce-LndEvhRk.js";
import { i as formatErrorMessage } from "./errors-ixwfrboQ.js";
import { n as isRich, r as theme } from "./theme-CStEj1vt.js";
import { t as createLazyImportLoader } from "./lazy-promise-SFT4i6yI.js";
import { i as resolveAgentModelPrimaryValue } from "./model-input-B9p-bobB.js";
import { n as isAcpSessionKey, o as parseAgentSessionKey } from "./session-key-utils-bmH32UOR.js";
import { r as writeRuntimeJson } from "./runtime-DDH_zqCr.js";
import { n as info } from "./globals-Cnlrc0S3.js";
import { i as getRuntimeConfig } from "./io-ByDvK3jv.js";
import { n as DEFAULT_MODEL, r as DEFAULT_PROVIDER } from "./defaults-D0p0lnLM.js";
import "./config-CIM_gEq1.js";
import { t as loadSessionStore } from "./store-load-CYzFXvuT.js";
import { l as resolveSessionTotalTokens } from "./types-CXS4Fv_X.js";
import { i as resolveSessionStoreTargets } from "./targets-CO_s04tR.js";
import "./sessions-B5_JTnFp.js";
import { c as inferUniqueProviderFromConfiguredModels } from "./model-selection-shared-Dhs7ZDUG.js";
import { t as isCliProvider } from "./model-selection-cli-_EkglUGn.js";
import "./model-selection-BxUseaAH.js";
import { t as resolveModelAgentRuntimeMetadata } from "./agent-runtime-metadata-CP0u4Rlo.js";
import { n as formatTimeAgo } from "./format-relative-BLNvqgYu.js";
import { t as classifySessionKind } from "./classify-session-kind-feNZW3YO.js";
import { t as resolveAgentRuntimeLabel } from "./agent-runtime-label-x_RId_CP.js";
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
		row.sessionId ? `id:${row.sessionId}` : null
	].filter(Boolean).join(" ");
	return label.length === 0 ? "" : rich ? theme.muted(label) : label;
}
//#endregion
//#region src/commands/sessions.ts
const AGENT_PAD = 10;
const KIND_PAD = 11;
const RUNTIME_PAD = 18;
const TOKENS_PAD = 20;
const DEFAULT_SESSIONS_LIMIT = 100;
const TOP_N_SELECTION_LIMIT = 200;
const contextLookupRuntimeLoader = createLazyImportLoader(() => import("./context-BOAVxARm.js"));
const formatKTokens = (value) => `${(value / 1e3).toFixed(value >= 1e4 ? 0 : 1)}k`;
/**
* Inline ACP model overlay — catalog #20.
*
* When a session ran via the ACP control plane (e.g. key =
* `agent:copilot:acp:<uuid>` AND `entry.acp` is present), the agent's
* configured model is irrelevant: the actual model is selected inside the ACP
* child process. We overlay a sentinel `{ provider: "acpx",
* model: "<agentId>-acp" }` so the listing clearly signals "ACP runtime" and
* does not mislead operators into thinking the configured model ran.
*
* Key-shape alone is not sufficient: ACP bridge sessions (translator.ts) also
* use ACP-shaped keys but never persist `SessionAcpMeta` — they run the
* normal configured model and must not receive the sentinel. The `acpRuntime`
* flag is set at row-construction time from `entry.acp != null`.
*
* The resolver (`resolveSessionDisplayModelRef`) stays pure; this overlay
* applies only at the emit sites in this file.
*
* NOTE: Will be replaced by a shared `applyAcpModelOverlay` helper from
* `src/agents/acp-runtime-overlay.ts` once PR 2 lands.
*/
function applyAcpModelOverlayIfNeeded(modelRef, sessionKey, acpRuntime) {
	if (!acpRuntime || !isAcpSessionKey(sessionKey)) return modelRef;
	return {
		provider: "acpx",
		model: `${parseAgentSessionKey(sessionKey)?.agentId ?? "acp"}-acp`
	};
}
function compareSessionRowsByUpdatedAt(a, b) {
	return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
}
function selectNewestSessionRows(rows, limit) {
	if (limit === void 0) return rows.toSorted(compareSessionRowsByUpdatedAt);
	if (limit > TOP_N_SELECTION_LIMIT) return rows.toSorted(compareSessionRowsByUpdatedAt).slice(0, limit);
	const selected = [];
	for (const row of rows) {
		const insertAt = selected.findIndex((candidate) => compareSessionRowsByUpdatedAt(row, candidate) < 0);
		if (insertAt >= 0) {
			selected.splice(insertAt, 0, row);
			if (selected.length > limit) selected.pop();
		} else if (selected.length < limit) selected.push(row);
	}
	return selected;
}
function parseSessionsLimit(value) {
	if (value === void 0) return DEFAULT_SESSIONS_LIMIT;
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.toLowerCase() === "all") return;
		if (!/^\d+$/.test(trimmed)) return null;
		const parsed = Number.parseInt(trimmed, 10);
		return parsed > 0 ? parsed : null;
	}
	return Number.isInteger(value) && value > 0 ? value : null;
}
const colorByPct = (label, pct, rich) => {
	if (!rich || pct === null) return label;
	if (pct >= 95) return theme.error(label);
	if (pct >= 80) return theme.warn(label);
	if (pct >= 60) return theme.success(label);
	return theme.muted(label);
};
const formatTokensCell = (total, contextTokens, rich) => {
	if (total === void 0) {
		const label = `unknown/${contextTokens ? formatKTokens(contextTokens) : "?"} (?%)`;
		return rich ? theme.muted(label.padEnd(TOKENS_PAD)) : label.padEnd(TOKENS_PAD);
	}
	const totalLabel = formatKTokens(total);
	const ctxLabel = contextTokens ? formatKTokens(contextTokens) : "?";
	const pct = contextTokens ? Math.min(999, Math.round(total / contextTokens * 100)) : null;
	return colorByPct(`${totalLabel}/${ctxLabel} (${pct ?? "?"}%)`.padEnd(TOKENS_PAD), pct, rich);
};
async function lookupContextTokensForDisplay(model) {
	const { lookupContextTokens } = await contextLookupRuntimeLoader.load();
	return lookupContextTokens(model, { allowAsyncLoad: false });
}
const formatKindCell = (kind, rich) => {
	const label = kind.padEnd(KIND_PAD);
	if (!rich) return label;
	if (kind === "group") return theme.accentBright(label);
	if (kind === "global") return theme.warn(label);
	if (kind === "direct") return theme.accent(label);
	return theme.muted(label);
};
function resolveSessionRuntimeLabel(params) {
	const id = normalizeOptionalLowercaseString(params.agentRuntime.id);
	const resolvedHarness = id && id !== "pi" && id !== "auto" ? id : void 0;
	return resolveAgentRuntimeLabel({
		config: params.cfg,
		sessionEntry: params.entry,
		resolvedHarness,
		fallbackProvider: params.modelProvider
	});
}
function formatRuntimeCell(runtimeLabel, rich) {
	const label = runtimeLabel.padEnd(RUNTIME_PAD);
	return rich ? theme.info(label) : label;
}
function toJsonSessionRow(row) {
	const { runtimeLabel, ...jsonRow } = row;
	return jsonRow;
}
async function sessionsCommand(opts, runtime) {
	const aggregateAgents = opts.allAgents === true;
	const cfg = getRuntimeConfig();
	const displayDefaults = resolveSessionDisplayDefaults(cfg);
	const configuredContextTokens = cfg.agents?.defaults?.contextTokens;
	const configContextTokens = configuredContextTokens ?? await lookupContextTokensForDisplay(displayDefaults.model) ?? 2e5;
	const targets = resolveSessionStoreTargetsOrExit({
		cfg,
		opts: {
			store: opts.store,
			agent: opts.agent,
			allAgents: opts.allAgents
		},
		runtime
	});
	if (!targets) return;
	let activeMinutes;
	if (opts.active !== void 0) {
		const parsed = Number.parseInt(opts.active, 10);
		if (Number.isNaN(parsed) || parsed <= 0) {
			runtime.error("--active must be a positive number of minutes, for example --active 30.");
			runtime.exit(1);
			return;
		}
		activeMinutes = parsed;
	}
	const limit = parseSessionsLimit(opts.limit);
	if (limit === null) {
		runtime.error("--limit must be a positive integer or \"all\", for example --limit 25.");
		runtime.exit(1);
		return;
	}
	const allRows = targets.flatMap((target) => {
		const store = loadSessionStore(target.storePath);
		return Object.entries(store).filter(([, entry]) => {
			if (activeMinutes === void 0) return true;
			const updatedAt = entry?.updatedAt;
			return typeof updatedAt === "number" && Date.now() - updatedAt <= activeMinutes * 6e4;
		}).map(([key, entry]) => {
			const row = toSessionDisplayRow(key, entry);
			const agentId = parseAgentSessionKey(row.key)?.agentId ?? target.agentId;
			const acpRuntime = entry?.acp != null;
			const modelRef = applyAcpModelOverlayIfNeeded(resolveSessionDisplayModelRef(cfg, row), row.key, acpRuntime);
			const agentRuntime = resolveModelAgentRuntimeMetadata({
				cfg,
				agentId,
				provider: modelRef.provider,
				model: modelRef.model,
				sessionKey: row.key,
				acpRuntime,
				acpBackend: entry?.acp?.backend
			});
			return Object.assign({}, row, {
				agentId,
				acpRuntime,
				agentRuntime,
				kind: classifySessionKind(row.key, store[row.key]),
				runtimeLabel: resolveSessionRuntimeLabel({
					cfg,
					entry,
					agentRuntime,
					modelProvider: modelRef.provider,
					model: modelRef.model,
					agentId,
					sessionKey: row.key
				})
			});
		});
	});
	const totalCount = allRows.length;
	const rows = selectNewestSessionRows(allRows, limit);
	const hasMore = rows.length < totalCount;
	if (opts.json) {
		const multi = targets.length > 1;
		const aggregate = aggregateAgents || multi;
		writeRuntimeJson(runtime, {
			path: aggregate ? null : targets[0]?.storePath ?? null,
			stores: aggregate ? targets.map((target) => ({
				agentId: target.agentId,
				path: target.storePath
			})) : void 0,
			allAgents: aggregateAgents ? true : void 0,
			count: rows.length,
			totalCount,
			limitApplied: limit ?? null,
			hasMore,
			activeMinutes: activeMinutes ?? null,
			sessions: await Promise.all(rows.map(async (row) => {
				const r = toJsonSessionRow(row);
				const modelRef = applyAcpModelOverlayIfNeeded(resolveSessionDisplayModelRef(cfg, r), r.key, row.acpRuntime);
				return {
					...r,
					totalTokens: resolveSessionTotalTokens(r) ?? null,
					totalTokensFresh: typeof r.totalTokens === "number" ? r.totalTokensFresh !== false : false,
					contextTokens: r.contextTokens ?? configuredContextTokens ?? await lookupContextTokensForDisplay(modelRef.model) ?? configContextTokens ?? null,
					modelProvider: modelRef.provider,
					model: modelRef.model
				};
			}))
		});
		return;
	}
	if (targets.length === 1 && !aggregateAgents) runtime.log(info(`Session store: ${targets[0]?.storePath}`));
	else runtime.log(info(`Session stores: ${targets.length} (${targets.map((t) => t.agentId).join(", ")})`));
	runtime.log(info(hasMore && limit !== void 0 ? `Sessions listed: ${rows.length} of ${totalCount} (limit ${limit})` : `Sessions listed: ${rows.length}`));
	if (activeMinutes) runtime.log(info(`Filtered to last ${activeMinutes} minute(s)`));
	if (rows.length === 0) {
		runtime.log("No sessions found.");
		return;
	}
	const rich = isRich();
	const showAgentColumn = aggregateAgents || targets.length > 1;
	const header = [
		...showAgentColumn ? ["Agent".padEnd(AGENT_PAD)] : [],
		"Kind".padEnd(KIND_PAD),
		"Key".padEnd(26),
		"Age".padEnd(9),
		"Model".padEnd(14),
		"Runtime".padEnd(RUNTIME_PAD),
		"Tokens (ctx %)".padEnd(TOKENS_PAD),
		"Flags"
	].join(" ");
	runtime.log(rich ? theme.heading(header) : header);
	for (const row of rows) {
		const model = applyAcpModelOverlayIfNeeded(resolveSessionDisplayModelRef(cfg, row), row.key, row.acpRuntime).model;
		const contextTokens = row.contextTokens ?? configuredContextTokens ?? await lookupContextTokensForDisplay(model) ?? configContextTokens;
		const total = resolveSessionTotalTokens(row);
		const line = [
			...showAgentColumn ? [rich ? theme.accentBright(row.agentId.padEnd(AGENT_PAD)) : row.agentId.padEnd(AGENT_PAD)] : [],
			formatKindCell(row.kind, rich),
			formatSessionKeyCell(row.key, rich),
			formatSessionAgeCell(row.updatedAt, rich),
			formatSessionModelCell(model, rich),
			formatRuntimeCell(row.runtimeLabel, rich),
			formatTokensCell(total, contextTokens ?? null, rich),
			formatSessionFlagsCell(row, rich)
		].join(" ");
		runtime.log(line.trimEnd());
	}
}
//#endregion
export { formatSessionModelCell as a, resolveSessionStoreTargetsOrExit as c, formatSessionKeyCell as i, formatSessionAgeCell as n, toSessionDisplayRows as o, formatSessionFlagsCell as r, resolveSessionDisplayModel as s, sessionsCommand as t };
