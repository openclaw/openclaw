import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import { _ as resolveSessionAgentId } from "./agent-scope-CtLXGcWm.js";
import { n as resolveDefaultAgentWorkspaceDir } from "./workspace-default--mMaLHGD.js";
import { a as resolveAgentDir, o as resolveAgentWorkspaceDir } from "./agent-scope-config-CMp71_27.js";
import { a as listOpenAIAuthProfileProvidersForAgentRuntime } from "./openai-codex-routing-DwRY-_VI.js";
import { t as resolveAgentHarnessPolicy } from "./policy-BwWh-R0D.js";
import { t as getChannelPlugin } from "./registry-Bf5TpUad.js";
import "./plugins-DYTHbmt7.js";
import { _ as resolveBareModelDefaultProvider, i as buildModelAliasIndex, x as resolveModelRefFromString } from "./model-selection-shared-ClxdEp4X.js";
import { s as resolveDefaultModelForAgent } from "./model-selection-P-81eBKx.js";
import { n as loadModelCatalog } from "./model-catalog-DhWpNp70.js";
import "./workspace-DTx8zuCN.js";
import { o as listLegacyRuntimeModelProviderAliases, r as isCliRuntimeProvider } from "./model-runtime-aliases-D35Lx2no.js";
import { t as createModelVisibilityPolicy } from "./model-visibility-policy-X7G_tvfc.js";
import { t as resolveAgentRuntimeLabel } from "./agent-runtime-label-DPvzpWzS.js";
import { r as rejectUnauthorizedCommand } from "./command-gates-DbPt0txV.js";
import { t as resolveModelAuthLabel } from "./model-auth-label-ByocD3Wn.js";
import { t as loadModelCatalogForBrowse } from "./model-catalog-browse-C1cYTG2K.js";
import { n as createProviderAuthChecker } from "./model-provider-auth-DAG1ddFR.js";
import { t as resolveVisibleModelCatalog } from "./model-catalog-visibility-kfqhTKJH.js";
import { n as isModelPickerVisibleProvider } from "./model-picker-visibility-BzELkrLo.js";
//#region src/auto-reply/reply/commands-models.ts
const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MAX = 100;
const MODELS_ADD_DEPRECATED_TEXT = "⚠️ /models add is deprecated. Use /models to browse providers and /model to switch models.";
function isModelsBrowseVisibleProvider(provider) {
	const normalized = normalizeProviderId(provider);
	return isCliRuntimeProvider(normalized) || isModelPickerVisibleProvider(normalized);
}
function usesUnfilteredCatalogModels(provider) {
	return isCliRuntimeProvider(provider);
}
function normalizeRuntimeChoiceId(runtime) {
	const normalized = normalizeLowercaseStringOrEmpty(runtime);
	if (!normalized || normalized === "auto" || normalized === "default") return "pi";
	return normalized;
}
function buildRuntimeChoice(params) {
	const id = normalizeRuntimeChoiceId(params.runtime);
	const label = resolveAgentRuntimeLabel({
		config: params.cfg,
		resolvedHarness: id
	});
	return {
		id,
		label,
		description: id === "pi" ? "Use the built-in OpenClaw Pi runtime." : params.cli ? `Run ${params.provider} models through ${label}.` : `Use the ${label} runtime selected by the effective harness policy.`
	};
}
function buildDefaultRuntimeChoice(params) {
	const harnessPolicy = resolveAgentHarnessPolicy({
		config: params.cfg,
		provider: params.provider,
		modelId: params.modelId,
		agentId: params.agentId
	});
	return buildRuntimeChoice({
		cfg: params.cfg,
		provider: params.provider,
		runtime: harnessPolicy.runtime
	});
}
function addRuntimeChoice(choices, choice) {
	if (!choices.some((existing) => existing.id === choice.id)) choices.push(choice);
	return choices;
}
async function buildModelsProviderData(cfg, agentId, options = {}) {
	const resolvedDefault = resolveDefaultModelForAgent({
		cfg,
		agentId
	});
	const catalog = await loadModelCatalogForBrowse({
		cfg,
		view: options.view ?? "default",
		loadCatalog: ({ readOnly }) => loadModelCatalog({
			config: cfg,
			readOnly
		})
	});
	const visibilityPolicy = createModelVisibilityPolicy({
		cfg,
		catalog,
		defaultProvider: resolvedDefault.provider,
		defaultModel: resolvedDefault.model,
		agentId
	});
	const visibleCatalog = await resolveVisibleModelCatalog({
		cfg,
		catalog,
		defaultProvider: resolvedDefault.provider,
		defaultModel: resolvedDefault.model,
		agentId,
		workspaceDir: options.workspaceDir ?? (agentId ? resolveAgentWorkspaceDir(cfg, agentId) : void 0) ?? resolveDefaultAgentWorkspaceDir(),
		view: options.view,
		runtimeAuthDiscovery: false
	});
	const aliasIndex = buildModelAliasIndex({
		cfg,
		defaultProvider: resolvedDefault.provider
	});
	const restrictToProviderWildcards = options.view !== "all" && visibilityPolicy.hasProviderWildcards;
	const byProvider = /* @__PURE__ */ new Map();
	const add = (p, m) => {
		const key = normalizeProviderId(p);
		if (!isModelsBrowseVisibleProvider(key)) return;
		if (restrictToProviderWildcards && !usesUnfilteredCatalogModels(key) && !visibilityPolicy.allows({
			provider: key,
			model: m
		})) return;
		const set = byProvider.get(key) ?? /* @__PURE__ */ new Set();
		set.add(m);
		byProvider.set(key, set);
	};
	const addRawModelRef = (raw) => {
		const trimmed = normalizeOptionalString(raw);
		if (!trimmed) return;
		const resolved = resolveModelRefFromString({
			raw: trimmed,
			defaultProvider: !trimmed.includes("/") ? resolveBareModelDefaultProvider({
				cfg,
				catalog,
				model: trimmed,
				defaultProvider: resolvedDefault.provider
			}) : resolvedDefault.provider,
			aliasIndex
		});
		if (!resolved) return;
		add(resolved.ref.provider, resolved.ref.model);
	};
	const addModelConfigEntries = () => {
		const modelConfig = cfg.agents?.defaults?.model;
		if (typeof modelConfig === "string") addRawModelRef(modelConfig);
		else if (modelConfig && typeof modelConfig === "object") {
			addRawModelRef(modelConfig.primary);
			for (const fallback of modelConfig.fallbacks ?? []) addRawModelRef(fallback);
		}
		const imageConfig = cfg.agents?.defaults?.imageModel;
		if (typeof imageConfig === "string") addRawModelRef(imageConfig);
		else if (imageConfig && typeof imageConfig === "object") {
			addRawModelRef(imageConfig.primary);
			for (const fallback of imageConfig.fallbacks ?? []) addRawModelRef(fallback);
		}
	};
	for (const entry of visibleCatalog) add(entry.provider, entry.id);
	const hasAuth = options.view === "all" ? async () => true : createProviderAuthChecker({
		cfg,
		workspaceDir: options.workspaceDir ?? (agentId ? resolveAgentWorkspaceDir(cfg, agentId) : void 0) ?? resolveDefaultAgentWorkspaceDir(),
		agentId
	});
	for (const entry of catalog) if (usesUnfilteredCatalogModels(entry.provider) && await hasAuth(entry.provider)) add(entry.provider, entry.id);
	for (const raw of visibilityPolicy.exactModelRefs) addRawModelRef(raw);
	add(resolvedDefault.provider, resolvedDefault.model);
	addModelConfigEntries();
	const providers = [...byProvider.keys()].toSorted();
	const modelNames = /* @__PURE__ */ new Map();
	for (const entry of [...catalog, ...visibleCatalog]) if (entry.name && entry.name !== entry.id) modelNames.set(`${normalizeProviderId(entry.provider)}/${entry.id}`, entry.name);
	const runtimeChoicesByProvider = /* @__PURE__ */ new Map();
	for (const alias of listLegacyRuntimeModelProviderAliases()) {
		const provider = normalizeProviderId(alias.provider);
		const defaultModelId = provider === normalizeProviderId(resolvedDefault.provider) ? resolvedDefault.model : void 0;
		const choices = runtimeChoicesByProvider.get(provider) ?? [buildDefaultRuntimeChoice({
			cfg,
			agentId,
			provider,
			modelId: defaultModelId
		})];
		addRuntimeChoice(choices, buildRuntimeChoice({
			cfg,
			provider,
			runtime: "pi"
		}));
		addRuntimeChoice(choices, buildRuntimeChoice({
			cfg,
			provider,
			runtime: alias.runtime,
			cli: alias.cli
		}));
		runtimeChoicesByProvider.set(provider, choices);
	}
	return {
		byProvider,
		providers,
		resolvedDefault,
		modelNames,
		runtimeChoicesByProvider
	};
}
function formatProviderLine(params) {
	return `- ${params.provider} (${params.count})`;
}
function parseListArgs(tokens) {
	const provider = normalizeOptionalString(tokens[0]);
	let page = 1;
	let all = false;
	for (const token of tokens.slice(1)) {
		const lower = normalizeLowercaseStringOrEmpty(token);
		if (lower === "all" || lower === "--all") {
			all = true;
			continue;
		}
		if (lower.startsWith("page=")) {
			const value = Number.parseInt(lower.slice(5), 10);
			if (Number.isFinite(value) && value > 0) page = value;
			continue;
		}
		if (/^[0-9]+$/.test(lower)) {
			const value = Number.parseInt(lower, 10);
			if (Number.isFinite(value) && value > 0) page = value;
		}
	}
	let pageSize = PAGE_SIZE_DEFAULT;
	for (const token of tokens) {
		const lower = normalizeLowercaseStringOrEmpty(token);
		if (lower.startsWith("limit=") || lower.startsWith("size=")) {
			const rawValue = lower.slice(lower.indexOf("=") + 1);
			const value = Number.parseInt(rawValue, 10);
			if (Number.isFinite(value) && value > 0) pageSize = Math.min(PAGE_SIZE_MAX, value);
		}
	}
	return {
		action: "list",
		provider: provider ? normalizeProviderId(provider) : void 0,
		page,
		pageSize,
		all
	};
}
function parseModelsArgs(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return { action: "providers" };
	const tokens = trimmed.split(/\s+/g).filter(Boolean);
	switch (normalizeLowercaseStringOrEmpty(tokens[0])) {
		case "providers": return { action: "providers" };
		case "list": return parseListArgs(tokens.slice(1));
		case "add": return {
			action: "add",
			provider: normalizeOptionalString(tokens[1]),
			modelId: normalizeOptionalString(tokens.slice(2).join(" "))
		};
		default: return parseListArgs(tokens);
	}
}
function resolveProviderLabel(params) {
	const harnessPolicy = resolveAgentHarnessPolicy({
		config: params.cfg,
		provider: params.provider,
		agentId: params.agentId
	});
	const acceptedProviderIds = listOpenAIAuthProfileProvidersForAgentRuntime({
		provider: params.provider,
		harnessRuntime: harnessPolicy.runtime,
		config: params.cfg
	});
	const authLabel = resolveModelAuthLabel({
		provider: params.provider,
		acceptedProviderIds,
		cfg: params.cfg,
		sessionEntry: params.sessionEntry,
		agentDir: params.agentDir,
		workspaceDir: params.workspaceDir
	});
	if (!authLabel || authLabel === "unknown") return params.provider;
	return `${params.provider} · 🔑 ${authLabel}`;
}
function formatModelsAvailableHeader(params) {
	return `Models (${resolveProviderLabel({
		provider: params.provider,
		cfg: params.cfg,
		agentId: params.agentId,
		agentDir: params.agentDir,
		workspaceDir: params.workspaceDir,
		sessionEntry: params.sessionEntry
	})}) — ${params.total} available`;
}
function buildModelsMenuText(params) {
	return [
		"Providers:",
		...params.providers.map((provider) => formatProviderLine({
			provider,
			count: params.byProvider.get(provider)?.size ?? 0
		})),
		"",
		"Use: /models <provider>",
		"Switch: /model <provider/model>"
	].join("\n");
}
function buildProviderInfos(params) {
	return params.providers.map((provider) => ({
		id: provider,
		count: params.byProvider.get(provider)?.size ?? 0
	}));
}
async function resolveModelsCommandReply(params) {
	const body = params.commandBodyNormalized.trim();
	if (!body.startsWith("/models")) return null;
	const parsed = parseModelsArgs(body.replace(/^\/models\b/i, "").trim());
	const { byProvider, providers, modelNames } = await buildModelsProviderData(params.cfg, params.agentId, {
		...parsed.action === "list" && parsed.all ? { view: "all" } : {},
		workspaceDir: params.workspaceDir
	});
	const commandPlugin = params.surface ? getChannelPlugin(params.surface) : null;
	const providerInfos = buildProviderInfos({
		providers,
		byProvider
	});
	if (parsed.action === "providers") {
		const channelData = commandPlugin?.commands?.buildModelsMenuChannelData?.({ providers: providerInfos }) ?? commandPlugin?.commands?.buildModelsProviderChannelData?.({ providers: providerInfos });
		if (channelData) return {
			text: "Select a provider:",
			channelData
		};
		return { text: buildModelsMenuText({
			providers,
			byProvider
		}) };
	}
	if (parsed.action === "add") return { text: MODELS_ADD_DEPRECATED_TEXT };
	const { provider, page, pageSize, all } = parsed;
	if (!provider) {
		const channelData = commandPlugin?.commands?.buildModelsProviderChannelData?.({ providers: providerInfos });
		if (channelData) return {
			text: "Select a provider:",
			channelData
		};
		return { text: buildModelsMenuText({
			providers,
			byProvider
		}) };
	}
	if (!byProvider.has(provider)) return { text: [
		`Unknown provider: ${provider}`,
		"",
		"Available providers:",
		...providers.map((entry) => `- ${entry}`),
		"",
		"Use: /models <provider>"
	].join("\n") };
	const models = [...byProvider.get(provider) ?? /* @__PURE__ */ new Set()].toSorted();
	const total = models.length;
	if (total === 0) return { text: [
		`Models (${resolveProviderLabel({
			provider,
			cfg: params.cfg,
			agentId: params.agentId,
			agentDir: params.agentDir,
			workspaceDir: params.workspaceDir,
			sessionEntry: params.sessionEntry
		})}) — none`,
		"",
		"Browse: /models",
		"Switch: /model <provider/model>"
	].join("\n") };
	const interactivePageSize = 8;
	const interactiveTotalPages = Math.max(1, Math.ceil(total / interactivePageSize));
	const interactivePage = Math.max(1, Math.min(page, interactiveTotalPages));
	const interactiveChannelData = commandPlugin?.commands?.buildModelsListChannelData?.({
		provider,
		models,
		currentModel: params.currentModel,
		currentPage: interactivePage,
		totalPages: interactiveTotalPages,
		pageSize: interactivePageSize,
		modelNames
	});
	if (interactiveChannelData) return {
		text: formatModelsAvailableHeader({
			provider,
			total,
			cfg: params.cfg,
			agentId: params.agentId,
			agentDir: params.agentDir,
			workspaceDir: params.workspaceDir,
			sessionEntry: params.sessionEntry
		}),
		channelData: interactiveChannelData
	};
	const effectivePageSize = all ? total : pageSize;
	const pageCount = effectivePageSize > 0 ? Math.ceil(total / effectivePageSize) : 1;
	const safePage = all ? 1 : Math.max(1, Math.min(page, pageCount));
	if (!all && page !== safePage) return { text: [
		`Page out of range: ${page} (valid: 1-${pageCount})`,
		"",
		`Try: /models list ${provider} ${safePage}`,
		`All: /models list ${provider} all`
	].join("\n") };
	const startIndex = (safePage - 1) * effectivePageSize;
	const endIndexExclusive = Math.min(total, startIndex + effectivePageSize);
	const pageModels = models.slice(startIndex, endIndexExclusive);
	const lines = [`Models (${resolveProviderLabel({
		provider,
		cfg: params.cfg,
		agentId: params.agentId,
		agentDir: params.agentDir,
		workspaceDir: params.workspaceDir,
		sessionEntry: params.sessionEntry
	})}) — showing ${startIndex + 1}-${endIndexExclusive} of ${total} (page ${safePage}/${pageCount})`];
	for (const id of pageModels) lines.push(`- ${provider}/${id}`);
	lines.push("", "Switch: /model <provider/model>");
	if (!all && safePage < pageCount) lines.push(`More: /models list ${provider} ${safePage + 1}`);
	if (!all) lines.push(`All: /models list ${provider} all`);
	return { text: lines.join("\n") };
}
const handleModelsCommand = async (params, allowTextCommands) => {
	if (!allowTextCommands) return null;
	const commandBodyNormalized = params.command.commandBodyNormalized.trim();
	if (!commandBodyNormalized.startsWith("/models")) return null;
	const parsed = parseModelsArgs(commandBodyNormalized.replace(/^\/models\b/i, "").trim());
	const unauthorized = rejectUnauthorizedCommand(params, "/models");
	if (unauthorized) return unauthorized;
	if (parsed.action === "add") return {
		shouldContinue: false,
		reply: { text: MODELS_ADD_DEPRECATED_TEXT }
	};
	const modelsAgentId = params.sessionKey ? resolveSessionAgentId({
		sessionKey: params.sessionKey,
		config: params.cfg
	}) : params.agentId ?? "main";
	const currentAgentId = params.agentId ?? "main";
	const modelsAgentDir = modelsAgentId === currentAgentId && params.agentDir ? params.agentDir : resolveAgentDir(params.cfg, modelsAgentId);
	const targetSessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;
	const reply = await resolveModelsCommandReply({
		cfg: params.cfg,
		commandBodyNormalized,
		surface: params.ctx.Surface,
		currentModel: params.model ? `${params.provider}/${params.model}` : void 0,
		agentId: modelsAgentId,
		agentDir: modelsAgentDir,
		workspaceDir: targetSessionEntry?.spawnedWorkspaceDir ?? (modelsAgentId === currentAgentId ? params.workspaceDir : void 0),
		sessionEntry: targetSessionEntry
	});
	if (!reply) return null;
	return {
		reply,
		shouldContinue: false
	};
};
//#endregion
export { resolveModelsCommandReply as i, formatModelsAvailableHeader as n, handleModelsCommand as r, buildModelsProviderData as t };
