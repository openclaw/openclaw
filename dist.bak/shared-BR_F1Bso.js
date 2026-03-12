import { $r as DEFAULT_PROVIDER, Jn as resolveModelRefFromString, L as writeConfigFile, N as readConfigFileSnapshot, Nn as buildModelAliasIndex, Rn as modelKey } from "./auth-profiles-D6H-HVV8.js";
import { t as formatCliCommand } from "./command-format-CDHXQh1_.js";
import { P as toAgentModelListLike, r as listAgentIds } from "./agent-scope-C2k6BQnt.js";
import { s as normalizeAgentId } from "./session-key-qmb11-mH.js";

//#region src/commands/models/shared.ts
const ensureFlagCompatibility = (opts) => {
	if (opts.json && opts.plain) throw new Error("Choose either --json or --plain, not both.");
};
const formatTokenK = (value) => {
	if (!value || !Number.isFinite(value)) return "-";
	if (value < 1024) return `${Math.round(value)}`;
	return `${Math.round(value / 1024)}k`;
};
const formatMs = (value) => {
	if (value === null || value === void 0) return "-";
	if (!Number.isFinite(value)) return "-";
	if (value < 1e3) return `${Math.round(value)}ms`;
	return `${Math.round(value / 100) / 10}s`;
};
const isLocalBaseUrl = (baseUrl) => {
	try {
		const host = new URL(baseUrl).hostname.toLowerCase();
		return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1" || host.endsWith(".local");
	} catch {
		return false;
	}
};
async function loadValidConfigOrThrow() {
	const snapshot = await readConfigFileSnapshot();
	if (!snapshot.valid) {
		const issues = snapshot.issues.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n");
		throw new Error(`Invalid config at ${snapshot.path}\n${issues}`);
	}
	return snapshot.config;
}
async function updateConfig(mutator) {
	const next = mutator(await loadValidConfigOrThrow());
	await writeConfigFile(next);
	return next;
}
function resolveModelTarget(params) {
	const aliasIndex = buildModelAliasIndex({
		cfg: params.cfg,
		defaultProvider: DEFAULT_PROVIDER
	});
	const resolved = resolveModelRefFromString({
		raw: params.raw,
		defaultProvider: DEFAULT_PROVIDER,
		aliasIndex
	});
	if (!resolved) throw new Error(`Invalid model reference: ${params.raw}`);
	return resolved.ref;
}
function resolveModelKeysFromEntries(params) {
	const aliasIndex = buildModelAliasIndex({
		cfg: params.cfg,
		defaultProvider: DEFAULT_PROVIDER
	});
	return params.entries.map((entry) => resolveModelRefFromString({
		raw: entry,
		defaultProvider: DEFAULT_PROVIDER,
		aliasIndex
	})).filter((entry) => Boolean(entry)).map((entry) => modelKey(entry.ref.provider, entry.ref.model));
}
function normalizeAlias(alias) {
	const trimmed = alias.trim();
	if (!trimmed) throw new Error("Alias cannot be empty.");
	if (!/^[A-Za-z0-9_.:-]+$/.test(trimmed)) throw new Error("Alias must use letters, numbers, dots, underscores, colons, or dashes.");
	return trimmed;
}
function resolveKnownAgentId(params) {
	const raw = params.rawAgentId?.trim();
	if (!raw) return;
	const agentId = normalizeAgentId(raw);
	if (!listAgentIds(params.cfg).includes(agentId)) throw new Error(`Unknown agent id "${raw}". Use "${formatCliCommand("openclaw agents list")}" to see configured agents.`);
	return agentId;
}
function mergePrimaryFallbackConfig(existing, patch) {
	const next = { ...existing && typeof existing === "object" ? existing : void 0 };
	if (patch.primary !== void 0) next.primary = patch.primary;
	if (patch.fallbacks !== void 0) next.fallbacks = patch.fallbacks;
	return next;
}
function applyDefaultModelPrimaryUpdate(params) {
	const resolved = resolveModelTarget({
		raw: params.modelRaw,
		cfg: params.cfg
	});
	const key = `${resolved.provider}/${resolved.model}`;
	const nextModels = { ...params.cfg.agents?.defaults?.models };
	if (!nextModels[key]) nextModels[key] = {};
	const defaults = params.cfg.agents?.defaults ?? {};
	const existing = toAgentModelListLike(defaults[params.field]);
	return {
		...params.cfg,
		agents: {
			...params.cfg.agents,
			defaults: {
				...defaults,
				[params.field]: mergePrimaryFallbackConfig(existing, { primary: key }),
				models: nextModels
			}
		}
	};
}
/**
* Model key format: "provider/model"
*
* The model key is displayed in `/model status` and used to reference models.
* When using `/model <key>`, use the exact format shown (e.g., "openrouter/moonshotai/kimi-k2").
*
* For providers with hierarchical model IDs (e.g., OpenRouter), the model ID may include
* sub-providers (e.g., "moonshotai/kimi-k2"), resulting in a key like "openrouter/moonshotai/kimi-k2".
*/

//#endregion
export { isLocalBaseUrl as a, normalizeAlias as c, resolveModelTarget as d, updateConfig as f, formatTokenK as i, resolveKnownAgentId as l, ensureFlagCompatibility as n, loadValidConfigOrThrow as o, formatMs as r, mergePrimaryFallbackConfig as s, applyDefaultModelPrimaryUpdate as t, resolveModelKeysFromEntries as u };