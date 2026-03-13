import { A as theme, k as isRich, y as info } from "./subsystem-DVwhOlEq.js";
import "./paths-BfR2LXbA.js";
import "./boolean-BHdNsbzF.js";
import { If as resolveSessionStoreTargets, Ji as resolveSessionModelRef, M as resolveConfiguredModelRef, Uf as loadSessionStore, Vi as classifySessionKey, Xi as formatTimeAgo, Zi as lookupContextTokens, xp as resolveFreshSessionTotalTokens, zg as loadConfig } from "./auth-profiles-CAw5gP6f.js";
import "./agent-scope-DBEC2O3x.js";
import { E as parseAgentSessionKey } from "./session-key-GuEQvqMH.js";
import "./utils-8QNki08A.js";
import "./boundary-file-read-CcBHg_z-.js";
import "./logger-CDI_b4HB.js";
import "./exec-CHkvLtoM.js";
import "./github-copilot-token-CcBrBN3h.js";
import "./registry-B23eaqdH.js";
import "./skills-D75zdym7.js";
import "./frontmatter-BsxcWDrh.js";
import "./env-overrides-DWoj3eoQ.js";
import "./version-N--ZkDj4.js";
import "./search-manager-B1FsI6Ow.js";
import "./plugins-BKDaOrHv.js";
import "./query-expansion-kdDusy7Q.js";
import "./redact-D9pXgQ9w.js";
import "./cli-utils-Cikq4_a8.js";
import "./fetch-ZNxqGXAR.js";
import "./path-alias-guards-Bq601o2U.js";
import "./delivery-queue-O9EZYTUe.js";
import "./paths-QMxjnO9x.js";
import "./session-cost-usage-6HYiRnfr.js";
import "./prompt-style-2BF77KhS.js";
import "./links-BpBLDDXV.js";
//#region src/commands/session-store-targets.ts
function resolveSessionStoreTargetsOrExit(params) {
	try {
		return resolveSessionStoreTargets(params.cfg, params.opts);
	} catch (error) {
		params.runtime.error(error instanceof Error ? error.message : String(error));
		params.runtime.exit(1);
		return null;
	}
}
function toSessionDisplayRows(store) {
	return Object.entries(store).map(([key, entry]) => {
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
	}).toSorted((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}
function resolveSessionDisplayDefaults(cfg) {
	return { model: resolveConfiguredModelRef({
		cfg,
		defaultProvider: "anthropic",
		defaultModel: "claude-opus-4-6"
	}).model ?? "claude-opus-4-6" };
}
function resolveSessionDisplayModel(cfg, row, defaults) {
	return resolveSessionModelRef(cfg, row, parseAgentSessionKey(row.key)?.agentId).model ?? defaults.model;
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
const KIND_PAD = 6;
const TOKENS_PAD = 20;
const formatKTokens = (value) => `${(value / 1e3).toFixed(value >= 1e4 ? 0 : 1)}k`;
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
const formatKindCell = (kind, rich) => {
	const label = kind.padEnd(KIND_PAD);
	if (!rich) return label;
	if (kind === "group") return theme.accentBright(label);
	if (kind === "global") return theme.warn(label);
	if (kind === "direct") return theme.accent(label);
	return theme.muted(label);
};
async function sessionsCommand(opts, runtime) {
	const aggregateAgents = opts.allAgents === true;
	const cfg = loadConfig();
	const displayDefaults = resolveSessionDisplayDefaults(cfg);
	const configContextTokens = cfg.agents?.defaults?.contextTokens ?? lookupContextTokens(displayDefaults.model) ?? 2e5;
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
		const parsed = Number.parseInt(String(opts.active), 10);
		if (Number.isNaN(parsed) || parsed <= 0) {
			runtime.error("--active must be a positive integer (minutes)");
			runtime.exit(1);
			return;
		}
		activeMinutes = parsed;
	}
	const rows = targets.flatMap((target) => {
		const store = loadSessionStore(target.storePath);
		return toSessionDisplayRows(store).map((row) => ({
			...row,
			agentId: parseAgentSessionKey(row.key)?.agentId ?? target.agentId,
			kind: classifySessionKey(row.key, store[row.key])
		}));
	}).filter((row) => {
		if (activeMinutes === void 0) return true;
		if (!row.updatedAt) return false;
		return Date.now() - row.updatedAt <= activeMinutes * 6e4;
	}).toSorted((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
	if (opts.json) {
		const multi = targets.length > 1;
		const aggregate = aggregateAgents || multi;
		runtime.log(JSON.stringify({
			path: aggregate ? null : targets[0]?.storePath ?? null,
			stores: aggregate ? targets.map((target) => ({
				agentId: target.agentId,
				path: target.storePath
			})) : void 0,
			allAgents: aggregateAgents ? true : void 0,
			count: rows.length,
			activeMinutes: activeMinutes ?? null,
			sessions: rows.map((r) => {
				const model = resolveSessionDisplayModel(cfg, r, displayDefaults);
				return {
					...r,
					totalTokens: resolveFreshSessionTotalTokens(r) ?? null,
					totalTokensFresh: typeof r.totalTokens === "number" ? r.totalTokensFresh !== false : false,
					contextTokens: r.contextTokens ?? lookupContextTokens(model) ?? configContextTokens ?? null,
					model
				};
			})
		}, null, 2));
		return;
	}
	if (targets.length === 1 && !aggregateAgents) runtime.log(info(`Session store: ${targets[0]?.storePath}`));
	else runtime.log(info(`Session stores: ${targets.length} (${targets.map((t) => t.agentId).join(", ")})`));
	runtime.log(info(`Sessions listed: ${rows.length}`));
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
		"Tokens (ctx %)".padEnd(TOKENS_PAD),
		"Flags"
	].join(" ");
	runtime.log(rich ? theme.heading(header) : header);
	for (const row of rows) {
		const model = resolveSessionDisplayModel(cfg, row, displayDefaults);
		const contextTokens = row.contextTokens ?? lookupContextTokens(model) ?? configContextTokens;
		const total = resolveFreshSessionTotalTokens(row);
		const line = [
			...showAgentColumn ? [rich ? theme.accentBright(row.agentId.padEnd(AGENT_PAD)) : row.agentId.padEnd(AGENT_PAD)] : [],
			formatKindCell(row.kind, rich),
			formatSessionKeyCell(row.key, rich),
			formatSessionAgeCell(row.updatedAt, rich),
			formatSessionModelCell(model, rich),
			formatTokensCell(total, contextTokens ?? null, rich),
			formatSessionFlagsCell(row, rich)
		].join(" ");
		runtime.log(line.trimEnd());
	}
}
//#endregion
export { resolveSessionDisplayDefaults as a, resolveSessionStoreTargetsOrExit as c, formatSessionModelCell as i, formatSessionFlagsCell as n, resolveSessionDisplayModel as o, formatSessionKeyCell as r, toSessionDisplayRows as s, sessionsCommand, formatSessionAgeCell as t };
