import { i as toAgentModelListLike, t as resolveAgentModelFallbackValues } from "./model-input-gjsFWrBi.js";
import { r as writeRuntimeJson } from "./runtime-bzt9CHmD.js";
import { r as DEFAULT_PROVIDER } from "./defaults-xppxcKrw.js";
import { h as resolveModelRefFromString, i as buildModelAliasIndex, x as modelKey } from "./model-selection-shared-BQtX8Bw-.js";
import "./model-selection-CyWx9aXc.js";
import { n as logConfigUpdated } from "./logging-DPg6HkJQ.js";
import { c as resolveModelKeysFromEntries, d as upsertCanonicalModelConfigEntry, l as resolveModelTarget, n as ensureFlagCompatibility, o as mergePrimaryFallbackConfig, u as updateConfig } from "./shared-CuyMvlgj.js";
import { t as loadModelsConfig } from "./load-config-B96SvIur.js";
//#region src/commands/models/fallbacks-shared.ts
function getFallbacks(cfg, key) {
	return resolveAgentModelFallbackValues(cfg.agents?.defaults?.[key]);
}
function patchDefaultsFallbacks(cfg, params) {
	const existing = toAgentModelListLike(cfg.agents?.defaults?.[params.key]);
	return {
		...cfg,
		agents: {
			...cfg.agents,
			defaults: {
				...cfg.agents?.defaults,
				[params.key]: mergePrimaryFallbackConfig(existing, { fallbacks: params.fallbacks }),
				...params.models ? { models: params.models } : void 0
			}
		}
	};
}
async function listFallbacksCommand(params, opts, runtime) {
	ensureFlagCompatibility(opts);
	const fallbacks = getFallbacks(await loadModelsConfig({
		commandName: `models ${params.key} list`,
		runtime
	}), params.key);
	if (opts.json) {
		writeRuntimeJson(runtime, { fallbacks });
		return;
	}
	if (opts.plain) {
		for (const entry of fallbacks) runtime.log(entry);
		return;
	}
	runtime.log(`${params.label} (${fallbacks.length}):`);
	if (fallbacks.length === 0) {
		runtime.log("- none");
		return;
	}
	for (const entry of fallbacks) runtime.log(`- ${entry}`);
}
async function addFallbackCommand(params, modelRaw, runtime) {
	const updated = await updateConfig((cfg) => {
		const resolved = resolveModelTarget({
			raw: modelRaw,
			cfg
		});
		const nextModels = { ...cfg.agents?.defaults?.models };
		const targetKey = upsertCanonicalModelConfigEntry(nextModels, resolved);
		const existing = getFallbacks(cfg, params.key);
		if (resolveModelKeysFromEntries({
			cfg,
			entries: existing
		}).includes(targetKey)) return cfg;
		return patchDefaultsFallbacks(cfg, {
			key: params.key,
			fallbacks: [...existing, targetKey],
			models: nextModels
		});
	});
	logConfigUpdated(runtime);
	runtime.log(`${params.logPrefix}: ${getFallbacks(updated, params.key).join(", ")}`);
}
async function removeFallbackCommand(params, modelRaw, runtime) {
	const updated = await updateConfig((cfg) => {
		const resolved = resolveModelTarget({
			raw: modelRaw,
			cfg
		});
		const targetKey = modelKey(resolved.provider, resolved.model);
		const aliasIndex = buildModelAliasIndex({
			cfg,
			defaultProvider: DEFAULT_PROVIDER
		});
		const existing = getFallbacks(cfg, params.key);
		const filtered = existing.filter((entry) => {
			const resolvedEntry = resolveModelRefFromString({
				raw: entry ?? "",
				defaultProvider: DEFAULT_PROVIDER,
				aliasIndex
			});
			if (!resolvedEntry) return true;
			return modelKey(resolvedEntry.ref.provider, resolvedEntry.ref.model) !== targetKey;
		});
		if (filtered.length === existing.length) throw new Error(`${params.notFoundLabel} not found: ${targetKey}`);
		return patchDefaultsFallbacks(cfg, {
			key: params.key,
			fallbacks: filtered
		});
	});
	logConfigUpdated(runtime);
	runtime.log(`${params.logPrefix}: ${getFallbacks(updated, params.key).join(", ")}`);
}
async function clearFallbacksCommand(params, runtime) {
	await updateConfig((cfg) => {
		return patchDefaultsFallbacks(cfg, {
			key: params.key,
			fallbacks: []
		});
	});
	logConfigUpdated(runtime);
	runtime.log(params.clearedMessage);
}
//#endregion
export { removeFallbackCommand as i, clearFallbacksCommand as n, listFallbacksCommand as r, addFallbackCommand as t };
