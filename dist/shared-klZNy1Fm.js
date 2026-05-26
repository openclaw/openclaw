import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-LndEvhRk.js";
import { t as formatCliCommand } from "./command-format-OwPqnbXG.js";
import { n as normalizeAgentModelRefForConfig, o as toAgentModelListLike } from "./model-input-B9p-bobB.js";
import { c as normalizeAgentId } from "./session-key-DFEyR49L.js";
import { n as listAgentIds } from "./agent-scope-config-26EcJVc0.js";
import "./agent-scope-C1Fl7gAf.js";
import { u as readConfigFileSnapshot } from "./io-5xE1dPMK.js";
import { n as formatConfigIssueLines } from "./issue-format-C1rff-gs.js";
import { r as DEFAULT_PROVIDER } from "./defaults-BGwElg4C.js";
import { r as replaceConfigFile } from "./mutate-FhI2HIyp.js";
import "./config-CzeRK-GW.js";
import { b as resolveModelRefFromString, i as buildModelAliasIndex } from "./model-selection-shared-Dh1KrVmr.js";
import { n as modelKey, t as legacyModelKey } from "./model-selection-normalize-B4tdZ1L4.js";
import "./model-selection-VRXWv5rs.js";
//#region src/commands/models/list.local-url.ts
const isLocalBaseUrl = (baseUrl) => {
	try {
		const host = normalizeLowercaseStringOrEmpty(new URL(baseUrl).hostname);
		return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1" || host.endsWith(".local");
	} catch {
		return false;
	}
};
//#endregion
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
async function loadValidConfigOrThrow() {
	const snapshot = await readConfigFileSnapshot();
	if (!snapshot.valid) {
		const issues = formatConfigIssueLines(snapshot.issues, "-").join("\n");
		throw new Error(`Invalid config at ${snapshot.path}\n${issues}`);
	}
	return snapshot.runtimeConfig ?? snapshot.config;
}
async function updateConfig(mutator) {
	const snapshot = await readConfigFileSnapshot();
	if (!snapshot.valid) {
		const issues = formatConfigIssueLines(snapshot.issues, "-").join("\n");
		throw new Error(`Invalid config at ${snapshot.path}\n${issues}`);
	}
	const next = mutator(structuredClone(snapshot.sourceConfig ?? snapshot.config));
	await replaceConfigFile({
		nextConfig: next,
		baseHash: snapshot.hash
	});
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
function resolveKnownAgentId(params) {
	const raw = params.rawAgentId?.trim();
	if (!raw) return;
	const agentId = normalizeAgentId(raw);
	if (!listAgentIds(params.cfg).includes(agentId)) throw new Error(`Unknown agent id "${raw}". Use "${formatCliCommand("openclaw agents list")}" to see configured agents.`);
	return agentId;
}
function upsertCanonicalModelConfigEntry(models, params) {
	const key = modelKey(params.provider, params.model);
	const legacyKeys = [legacyModelKey(params.provider, params.model), `${params.provider}/${key}`].filter((legacyKey) => typeof legacyKey === "string" && legacyKey.length > 0 && legacyKey !== key);
	let legacyEntry;
	for (const legacyKey of legacyKeys) {
		const entry = models[legacyKey];
		if (!entry) continue;
		Object.assign(legacyEntry ??= {}, entry);
		legacyEntry.params = {
			...legacyEntry.params,
			...entry.params
		};
	}
	if (legacyEntry) models[key] = {
		...legacyEntry,
		...models[key],
		params: {
			...legacyEntry.params,
			...models[key]?.params
		}
	};
	else if (!models[key]) models[key] = {};
	for (const legacyKey of legacyKeys) delete models[legacyKey];
	return key;
}
function mergePrimaryFallbackConfig(existing, patch) {
	const next = { ...existing && typeof existing === "object" ? existing : void 0 };
	if (patch.primary !== void 0) next.primary = normalizeAgentModelRefForConfig(patch.primary);
	if (patch.fallbacks !== void 0) next.fallbacks = patch.fallbacks.map((fallback) => normalizeAgentModelRefForConfig(fallback));
	else if (next.fallbacks !== void 0) next.fallbacks = next.fallbacks.map((fallback) => normalizeAgentModelRefForConfig(fallback));
	return next;
}
function applyDefaultModelPrimaryUpdate(params) {
	const resolved = resolveModelTarget({
		raw: params.modelRaw,
		cfg: params.cfg
	});
	const nextModels = { ...params.cfg.agents?.defaults?.models };
	const key = upsertCanonicalModelConfigEntry(nextModels, resolved);
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
export { loadValidConfigOrThrow as a, resolveModelKeysFromEntries as c, upsertCanonicalModelConfigEntry as d, isLocalBaseUrl as f, formatTokenK as i, resolveModelTarget as l, ensureFlagCompatibility as n, mergePrimaryFallbackConfig as o, formatMs as r, resolveKnownAgentId as s, applyDefaultModelPrimaryUpdate as t, updateConfig as u };
