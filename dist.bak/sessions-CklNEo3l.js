import { t as __exportAll } from "./rolldown-runtime-Cbj13DAv.js";
import { Dt as isRich, Ot as theme, _t as info } from "./entry.js";
import { $r as DEFAULT_PROVIDER, Gn as resolveConfiguredModelRef, Qr as DEFAULT_MODEL, Zr as DEFAULT_CONTEXT_TOKENS, j as loadConfig } from "./auth-profiles-D6H-HVV8.js";
import { d as resolveDefaultAgentId, r as listAgentIds } from "./agent-scope-C2k6BQnt.js";
import { s as normalizeAgentId, w as parseAgentSessionKey } from "./session-key-qmb11-mH.js";
import { X as resolveFreshSessionTotalTokens, c as loadSessionStore } from "./sessions-B8Y6oyPb.js";
import { l as resolveStorePath } from "./paths-DWsXK0S0.js";
import { n as formatTimeAgo } from "./format-relative-CLDwoKCS.js";
import { l as resolveSessionModelRef, n as classifySessionKey, u as lookupContextTokens } from "./session-utils-DJsCvZA5.js";

//#region src/commands/session-store-targets.ts
function dedupeTargetsByStorePath(targets) {
	const deduped = /* @__PURE__ */ new Map();
	for (const target of targets) if (!deduped.has(target.storePath)) deduped.set(target.storePath, target);
	return [...deduped.values()];
}
function resolveSessionStoreTargets(cfg, opts) {
	const defaultAgentId = resolveDefaultAgentId(cfg);
	const hasAgent = Boolean(opts.agent?.trim());
	const allAgents = opts.allAgents === true;
	if (hasAgent && allAgents) throw new Error("--agent and --all-agents cannot be used together");
	if (opts.store && (hasAgent || allAgents)) throw new Error("--store cannot be combined with --agent or --all-agents");
	if (opts.store) return [{
		agentId: defaultAgentId,
		storePath: resolveStorePath(opts.store, { agentId: defaultAgentId })
	}];
	if (allAgents) return dedupeTargetsByStorePath(listAgentIds(cfg).map((agentId) => ({
		agentId,
		storePath: resolveStorePath(cfg.session?.store, { agentId })
	})));
	if (hasAgent) {
		const knownAgents = listAgentIds(cfg);
		const requested = normalizeAgentId(opts.agent ?? "");
		if (!knownAgents.includes(requested)) throw new Error(`Unknown agent id "${opts.agent}". Use "openclaw agents list" to see configured agents.`);
		return [{
			agentId: requested,
			storePath: resolveStorePath(cfg.session?.store, { agentId: requested })
		}];
	}
	return [{
		agentId: defaultAgentId,
		storePath: resolveStorePath(cfg.session?.store, { agentId: defaultAgentId })
	}];
}

//#endregion
//#region src/commands/sessions-table.ts
const SESSION_KEY_PAD = 26;
const SESSION_AGE_PAD = 9;
const SESSION_MODEL_PAD = 14;
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
		defaultProvider: DEFAULT_PROVIDER,
		defaultModel: DEFAULT_MODEL
	}).model ?? DEFAULT_MODEL };
}
function resolveSessionDisplayModel(cfg, row, defaults) {
	return resolveSessionModelRef(cfg, row, parseAgentSessionKey(row.key)?.agentId).model ?? defaults.model;
}
function truncateSessionKey(key) {
	if (key.length <= SESSION_KEY_PAD) return key;
	const head = Math.max(4, SESSION_KEY_PAD - 10);
	return `${key.slice(0, head)}...${key.slice(-6)}`;
}
function formatSessionKeyCell(key, rich) {
	const label = truncateSessionKey(key).padEnd(SESSION_KEY_PAD);
	return rich ? theme.accent(label) : label;
}
function formatSessionAgeCell(updatedAt, rich) {
	const padded = (updatedAt ? formatTimeAgo(Date.now() - updatedAt) : "unknown").padEnd(SESSION_AGE_PAD);
	return rich ? theme.muted(padded) : padded;
}
function formatSessionModelCell(model, rich) {
	const label = (model ?? "unknown").padEnd(SESSION_MODEL_PAD);
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
var sessions_exports = /* @__PURE__ */ __exportAll({ sessionsCommand: () => sessionsCommand });
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
	const configContextTokens = cfg.agents?.defaults?.contextTokens ?? lookupContextTokens(displayDefaults.model) ?? DEFAULT_CONTEXT_TOKENS;
	let targets;
	try {
		targets = resolveSessionStoreTargets(cfg, {
			store: opts.store,
			agent: opts.agent,
			allAgents: opts.allAgents
		});
	} catch (error) {
		runtime.error(error instanceof Error ? error.message : String(error));
		runtime.exit(1);
		return;
	}
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
		"Key".padEnd(SESSION_KEY_PAD),
		"Age".padEnd(SESSION_AGE_PAD),
		"Model".padEnd(SESSION_MODEL_PAD),
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
export { SESSION_MODEL_PAD as a, formatSessionKeyCell as c, resolveSessionDisplayModel as d, toSessionDisplayRows as f, SESSION_KEY_PAD as i, formatSessionModelCell as l, sessions_exports as n, formatSessionAgeCell as o, resolveSessionStoreTargets as p, SESSION_AGE_PAD as r, formatSessionFlagsCell as s, sessionsCommand as t, resolveSessionDisplayDefaults as u };