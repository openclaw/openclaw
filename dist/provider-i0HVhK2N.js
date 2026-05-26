import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { a as normalizeModelCompat } from "./provider-model-compat-CmPOKTzc.js";
import "./core-kXuNbs5U.js";
import "./provider-model-shared-DtsPmvDx.js";
import { r as resolvePluginConfigObject } from "./plugin-config-runtime-DWa7yCpn.js";
import { a as buildCodexModelDefinition, i as FALLBACK_CODEX_MODELS, n as CODEX_BASE_URL, o as buildCodexProviderConfig, r as CODEX_PROVIDER_ID, t as CODEX_APP_SERVER_AUTH_MARKER } from "./provider-catalog-DBnUa2-J.js";
import { c as readCodexPluginConfig, l as resolveCodexAppServerRuntimeOptions } from "./config-CRe1vCzw.js";
import { i as resolveCodexSystemPromptContribution } from "./prompt-overlay-Bo9NYAE3.js";
//#region extensions/codex/provider.ts
const DEFAULT_DISCOVERY_TIMEOUT_MS = 2500;
const LIVE_DISCOVERY_ENV = "OPENCLAW_CODEX_DISCOVERY_LIVE";
const MODEL_DISCOVERY_PAGE_LIMIT = 100;
const CODEX_APP_SERVER_SETUP_METHOD_ID = "app-server";
const CODEX_DEFAULT_MODEL_REF = `${CODEX_PROVIDER_ID}/${FALLBACK_CODEX_MODELS[0].id}`;
const codexCatalogLog = createSubsystemLogger("codex/catalog");
function buildCodexProvider(options = {}) {
	return {
		id: CODEX_PROVIDER_ID,
		label: "Codex",
		docsPath: "/providers/models",
		auth: [{
			id: CODEX_APP_SERVER_SETUP_METHOD_ID,
			label: "Codex app-server",
			hint: "Use the Codex app-server runtime and managed model catalog.",
			kind: "custom",
			wizard: {
				choiceId: CODEX_PROVIDER_ID,
				choiceLabel: "Codex app-server",
				choiceHint: "Use the Codex app-server runtime and managed model catalog.",
				assistantPriority: -40,
				groupId: CODEX_PROVIDER_ID,
				groupLabel: "Codex",
				groupHint: "Codex app-server model provider",
				onboardingScopes: ["text-inference"]
			},
			run: async () => ({
				profiles: [],
				defaultModel: CODEX_DEFAULT_MODEL_REF
			})
		}],
		catalog: {
			order: "late",
			run: async (ctx) => {
				const pluginConfig = resolvePluginConfigObject(ctx.config, "codex") ?? (ctx.config ? void 0 : options.pluginConfig);
				return await buildCodexProviderCatalog({
					env: ctx.env,
					pluginConfig,
					listModels: options.listModels
				});
			}
		},
		staticCatalog: {
			order: "late",
			run: async () => ({ provider: buildCodexProviderConfig(FALLBACK_CODEX_MODELS) })
		},
		resolveDynamicModel: (ctx) => resolveCodexDynamicModel(ctx.modelId),
		resolveSyntheticAuth: () => ({
			apiKey: CODEX_APP_SERVER_AUTH_MARKER,
			source: "codex-app-server",
			mode: "token"
		}),
		resolveThinkingProfile: ({ modelId }) => ({ levels: [
			{ id: "off" },
			{ id: "minimal" },
			{ id: "low" },
			{ id: "medium" },
			{ id: "high" },
			...isKnownXHighCodexModel(modelId) ? [{ id: "xhigh" }] : []
		] }),
		resolveSystemPromptContribution: ({ config, modelId }) => resolveCodexSystemPromptContribution({
			config,
			modelId
		}),
		isModernModelRef: ({ modelId }) => isModernCodexModel(modelId)
	};
}
async function buildCodexProviderCatalog(options = {}) {
	const config = readCodexPluginConfig(options.pluginConfig);
	const appServer = resolveCodexAppServerRuntimeOptions({ pluginConfig: options.pluginConfig });
	const timeoutMs = normalizeTimeoutMs(config.discovery?.timeoutMs);
	let discovered = [];
	if (config.discovery?.enabled !== false && !shouldSkipLiveDiscovery(options.env)) discovered = await listModelsBestEffort({
		listModels: options.listModels ?? listCodexAppServerModelsLazy,
		timeoutMs,
		startOptions: appServer.start,
		onDiscoveryFailure: options.onDiscoveryFailure
	});
	return { provider: buildCodexProviderConfig(discovered.length > 0 ? discovered : FALLBACK_CODEX_MODELS) };
}
function resolveCodexDynamicModel(modelId) {
	const id = modelId.trim();
	if (!id) return;
	const fallbackModel = FALLBACK_CODEX_MODELS.find((model) => model.id === id);
	return normalizeModelCompat({
		...buildCodexModelDefinition({
			id,
			model: id,
			inputModalities: fallbackModel?.inputModalities ?? ["text"],
			supportedReasoningEfforts: fallbackModel?.supportedReasoningEfforts ?? (shouldDefaultToReasoningModel(id) ? ["medium"] : [])
		}),
		provider: CODEX_PROVIDER_ID,
		baseUrl: CODEX_BASE_URL
	});
}
async function listModelsBestEffort(params) {
	try {
		const models = [];
		let cursor;
		do {
			const result = await params.listModels({
				timeoutMs: params.timeoutMs,
				limit: MODEL_DISCOVERY_PAGE_LIMIT,
				cursor,
				startOptions: params.startOptions,
				sharedClient: false
			});
			models.push(...result.models.filter((model) => !model.hidden));
			cursor = result.nextCursor;
		} while (cursor);
		return models;
	} catch (error) {
		params.onDiscoveryFailure?.(error);
		codexCatalogLog.debug("codex model discovery failed; using fallback catalog", { error: error instanceof Error ? error.message : String(error) });
		return [];
	}
}
async function listCodexAppServerModelsLazy(options) {
	const { listCodexAppServerModels } = await import("./models-Bw4fpyH_.js");
	return listCodexAppServerModels(options);
}
function normalizeTimeoutMs(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : DEFAULT_DISCOVERY_TIMEOUT_MS;
}
function shouldSkipLiveDiscovery(env = process.env) {
	const override = env[LIVE_DISCOVERY_ENV]?.trim().toLowerCase();
	if (override === "0" || override === "false") return true;
	return Boolean(env.VITEST) && override !== "1";
}
function shouldDefaultToReasoningModel(modelId) {
	const lower = modelId.toLowerCase();
	return lower.startsWith("gpt-5") || lower.startsWith("o1") || lower.startsWith("o3") || lower.startsWith("o4");
}
function isKnownXHighCodexModel(modelId) {
	const lower = modelId.trim().toLowerCase();
	return lower.startsWith("gpt-5") || lower.startsWith("o3") || lower.startsWith("o4") || lower.includes("codex");
}
function isModernCodexModel(modelId) {
	const lower = modelId.trim().toLowerCase();
	return lower === "gpt-5.5" || lower === "gpt-5.4" || lower === "gpt-5.4-mini" || lower === "gpt-5.2";
}
//#endregion
export { buildCodexProviderCatalog as n, isModernCodexModel as r, buildCodexProvider as t };
