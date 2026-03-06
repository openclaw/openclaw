import { d as isRecord } from "./utils-BgHhhQlR.js";
import { $t as loadConfig, Kr as applyConfigEnvVars, M as resolveImplicitBedrockProvider, N as resolveImplicitCopilotProvider, P as resolveImplicitProviders, j as normalizeProviders, xi as resolveOpenClawAgentDir } from "./model-selection-Dmiyt9yA.js";
import path from "node:path";
import fs from "node:fs/promises";

//#region src/agents/models-config.ts
const DEFAULT_MODE = "merge";
function resolvePreferredTokenLimit(explicitValue, implicitValue) {
	return explicitValue > implicitValue ? explicitValue : implicitValue;
}
function mergeProviderModels(implicit, explicit) {
	const implicitModels = Array.isArray(implicit.models) ? implicit.models : [];
	const explicitModels = Array.isArray(explicit.models) ? explicit.models : [];
	if (implicitModels.length === 0) return {
		...implicit,
		...explicit
	};
	const getId = (model) => {
		if (!model || typeof model !== "object") return "";
		const id = model.id;
		return typeof id === "string" ? id.trim() : "";
	};
	const implicitById = new Map(implicitModels.map((model) => [getId(model), model]).filter(([id]) => Boolean(id)));
	const seen = /* @__PURE__ */ new Set();
	const mergedModels = explicitModels.map((explicitModel) => {
		const id = getId(explicitModel);
		if (!id) return explicitModel;
		seen.add(id);
		const implicitModel = implicitById.get(id);
		if (!implicitModel) return explicitModel;
		return {
			...explicitModel,
			input: implicitModel.input,
			reasoning: "reasoning" in explicitModel ? explicitModel.reasoning : implicitModel.reasoning,
			contextWindow: resolvePreferredTokenLimit(explicitModel.contextWindow, implicitModel.contextWindow),
			maxTokens: resolvePreferredTokenLimit(explicitModel.maxTokens, implicitModel.maxTokens)
		};
	});
	for (const implicitModel of implicitModels) {
		const id = getId(implicitModel);
		if (!id || seen.has(id)) continue;
		seen.add(id);
		mergedModels.push(implicitModel);
	}
	return {
		...implicit,
		...explicit,
		models: mergedModels
	};
}
function mergeProviders(params) {
	const out = params.implicit ? { ...params.implicit } : {};
	for (const [key, explicit] of Object.entries(params.explicit ?? {})) {
		const providerKey = key.trim();
		if (!providerKey) continue;
		const implicit = out[providerKey];
		out[providerKey] = implicit ? mergeProviderModels(implicit, explicit) : explicit;
	}
	return out;
}
async function readJson(pathname) {
	try {
		const raw = await fs.readFile(pathname, "utf8");
		return JSON.parse(raw);
	} catch {
		return null;
	}
}
async function resolveProvidersForModelsJson(params) {
	const { cfg, agentDir } = params;
	const explicitProviders = cfg.models?.providers ?? {};
	const providers = mergeProviders({
		implicit: await resolveImplicitProviders({
			agentDir,
			explicitProviders
		}),
		explicit: explicitProviders
	});
	const implicitBedrock = await resolveImplicitBedrockProvider({
		agentDir,
		config: cfg
	});
	if (implicitBedrock) {
		const existing = providers["amazon-bedrock"];
		providers["amazon-bedrock"] = existing ? mergeProviderModels(implicitBedrock, existing) : implicitBedrock;
	}
	const implicitCopilot = await resolveImplicitCopilotProvider({ agentDir });
	if (implicitCopilot && !providers["github-copilot"]) providers["github-copilot"] = implicitCopilot;
	return providers;
}
function mergeWithExistingProviderSecrets(params) {
	const { nextProviders, existingProviders } = params;
	const mergedProviders = {};
	for (const [key, entry] of Object.entries(existingProviders)) mergedProviders[key] = entry;
	for (const [key, newEntry] of Object.entries(nextProviders)) {
		const existing = existingProviders[key];
		if (!existing) {
			mergedProviders[key] = newEntry;
			continue;
		}
		const preserved = {};
		if (typeof existing.apiKey === "string" && existing.apiKey) preserved.apiKey = existing.apiKey;
		if (typeof existing.baseUrl === "string" && existing.baseUrl) preserved.baseUrl = existing.baseUrl;
		mergedProviders[key] = {
			...newEntry,
			...preserved
		};
	}
	return mergedProviders;
}
async function resolveProvidersForMode(params) {
	if (params.mode !== "merge") return params.providers;
	const existing = await readJson(params.targetPath);
	if (!isRecord(existing) || !isRecord(existing.providers)) return params.providers;
	const existingProviders = existing.providers;
	return mergeWithExistingProviderSecrets({
		nextProviders: params.providers,
		existingProviders
	});
}
async function readRawFile(pathname) {
	try {
		return await fs.readFile(pathname, "utf8");
	} catch {
		return "";
	}
}
async function ensureOpenClawModelsJson(config, agentDirOverride) {
	const cfg = config ?? loadConfig();
	const agentDir = agentDirOverride?.trim() ? agentDirOverride.trim() : resolveOpenClawAgentDir();
	applyConfigEnvVars(cfg);
	const providers = await resolveProvidersForModelsJson({
		cfg,
		agentDir
	});
	if (Object.keys(providers).length === 0) return {
		agentDir,
		wrote: false
	};
	const mode = cfg.models?.mode ?? DEFAULT_MODE;
	const targetPath = path.join(agentDir, "models.json");
	const normalizedProviders = normalizeProviders({
		providers: await resolveProvidersForMode({
			mode,
			targetPath,
			providers
		}),
		agentDir
	});
	const next = `${JSON.stringify({ providers: normalizedProviders }, null, 2)}\n`;
	if (await readRawFile(targetPath) === next) return {
		agentDir,
		wrote: false
	};
	await fs.mkdir(agentDir, {
		recursive: true,
		mode: 448
	});
	await fs.writeFile(targetPath, next, { mode: 384 });
	return {
		agentDir,
		wrote: true
	};
}

//#endregion
export { ensureOpenClawModelsJson as t };