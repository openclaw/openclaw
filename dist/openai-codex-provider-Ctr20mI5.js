import { a as normalizeLowercaseStringOrEmpty, f as readStringValue } from "./string-coerce-DyL154ka.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import "./defaults-mDjiWzE5.js";
import "./constants-D_82oc2f.js";
import { r as ensureAuthProfileStoreForLocalUpdate } from "./store-BMQkMM4l.js";
import { a as normalizeModelCompat } from "./provider-model-compat-CmPOKTzc.js";
import { n as listProfilesForProvider } from "./profile-list-C0HtPlut.js";
import "./error-runtime-DGHc7DZw.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { l as cloneFirstTemplateModel, u as matchesExactOrPrefix } from "./provider-model-shared-DtsPmvDx.js";
import { t as createProviderApiKeyAuthMethod } from "./provider-api-key-auth-E_5Yag4W.js";
import { t as buildOauthProviderAuthResult } from "./provider-auth-result-qR7142tf.js";
import "./provider-auth-BtRKd5us.js";
import { l as findCatalogTemplate } from "./provider-catalog-shared-BLp5nwNN.js";
import { i as fetchCodexUsage } from "./provider-usage-OfXY2nM7.js";
import { i as isOpenAICodexBaseUrl, r as isOpenAIApiBaseUrl, t as OPENAI_CODEX_RESPONSES_BASE_URL } from "./base-url-UKY1cn1G.js";
import { t as OPENAI_CODEX_DEFAULT_MODEL } from "./default-models-9Fo5IjIh.js";
import { n as buildOpenAISyntheticCatalogEntry, t as buildOpenAIResponsesProviderHooks } from "./shared-CrBPnArW.js";
import { c as OPENAI_CODEX_API_KEY_BACKUP_HINT, d as OPENAI_CODEX_DEVICE_PAIRING_LABEL, f as OPENAI_CODEX_LOGIN_HINT, l as OPENAI_CODEX_API_KEY_BACKUP_LABEL, m as OPENAI_CODEX_WIZARD_GROUP, p as OPENAI_CODEX_LOGIN_LABEL, u as OPENAI_CODEX_DEVICE_PAIRING_HINT } from "./auth-choice-copy-CI2uePXw.js";
import { n as resolveCodexAuthIdentity } from "./openai-codex-auth-identity-CsJMeCb3.js";
import { t as buildOpenAICodexProvider } from "./openai-codex-catalog-DJHLFOJe.js";
import { t as loginOpenAICodexDeviceCode } from "./openai-codex-device-code-D-auT-vb.js";
import { t as loginOpenAICodexOAuth } from "./openai-codex-oauth.runtime.js";
import { t as resolveOpenAICodexThinkingProfile } from "./thinking-policy-CkZmF4BG.js";
//#region extensions/openai/openai-codex-provider.ts
const PROVIDER_ID = "openai-codex";
const OPENAI_PROVIDER_ID = "openai";
const OPENAI_CODEX_BASE_URL = OPENAI_CODEX_RESPONSES_BASE_URL;
const OPENAI_CODEX_LOGIN_ASSISTANT_PRIORITY = -30;
const OPENAI_CODEX_DEVICE_PAIRING_ASSISTANT_PRIORITY = -10;
const OPENAI_CODEX_GPT_55_MODEL_ID = "gpt-5.5";
const OPENAI_CODEX_GPT_55_PRO_MODEL_ID = "gpt-5.5-pro";
const OPENAI_CODEX_GPT_54_MODEL_ID = "gpt-5.4";
const OPENAI_CODEX_GPT_54_LEGACY_MODEL_ID = "gpt-5.4-codex";
const OPENAI_CODEX_GPT_54_MINI_MODEL_ID = "gpt-5.4-mini";
const OPENAI_CODEX_GPT_54_PRO_MODEL_ID = "gpt-5.4-pro";
const OPENAI_CODEX_GPT_55_CODEX_CONTEXT_TOKENS = 4e5;
const OPENAI_CODEX_GPT_55_DEFAULT_RUNTIME_CONTEXT_TOKENS = 272e3;
const OPENAI_CODEX_GPT_55_PRO_NATIVE_CONTEXT_TOKENS = 1e6;
const OPENAI_CODEX_GPT_55_PRO_DEFAULT_CONTEXT_TOKENS = 272e3;
const OPENAI_CODEX_GPT_54_NATIVE_CONTEXT_TOKENS = 105e4;
const OPENAI_CODEX_GPT_54_DEFAULT_CONTEXT_TOKENS = 272e3;
const OPENAI_CODEX_GPT_54_MINI_NATIVE_CONTEXT_TOKENS = 4e5;
const OPENAI_CODEX_GPT_54_MAX_TOKENS = 128e3;
const OPENAI_CODEX_GPT_55_PRO_COST = {
	input: 30,
	output: 180,
	cacheRead: 0,
	cacheWrite: 0
};
const OPENAI_CODEX_GPT_54_COST = {
	input: 2.5,
	output: 15,
	cacheRead: .25,
	cacheWrite: 0
};
const OPENAI_CODEX_GPT_54_PRO_COST = {
	input: 30,
	output: 180,
	cacheRead: 0,
	cacheWrite: 0
};
const OPENAI_CODEX_GPT_54_MINI_COST = {
	input: .75,
	output: 4.5,
	cacheRead: .075,
	cacheWrite: 0
};
const OPENAI_CODEX_GPT_54_TEMPLATE_MODEL_IDS = ["gpt-5.3-codex", "gpt-5.2-codex"];
/** Legacy codex rows first; fall back to catalog `gpt-5.4` when the API omits 5.3/5.2. */
const OPENAI_CODEX_GPT_54_CATALOG_SYNTH_TEMPLATE_MODEL_IDS = [...OPENAI_CODEX_GPT_54_TEMPLATE_MODEL_IDS, OPENAI_CODEX_GPT_54_MODEL_ID];
const OPENAI_CODEX_GPT_55_PRO_TEMPLATE_MODEL_IDS = [
	OPENAI_CODEX_GPT_54_MODEL_ID,
	OPENAI_CODEX_GPT_54_PRO_MODEL_ID,
	...OPENAI_CODEX_GPT_54_TEMPLATE_MODEL_IDS
];
const OPENAI_CODEX_MODERN_MODEL_IDS = [
	OPENAI_CODEX_GPT_55_MODEL_ID,
	OPENAI_CODEX_GPT_55_PRO_MODEL_ID,
	OPENAI_CODEX_GPT_54_MODEL_ID,
	OPENAI_CODEX_GPT_54_PRO_MODEL_ID,
	OPENAI_CODEX_GPT_54_MINI_MODEL_ID
];
function isLegacyCodexCompatBaseUrl(baseUrl) {
	const trimmed = baseUrl?.trim();
	return !!trimmed && /^https?:\/\/api\.githubcopilot\.com(?:\/v1)?\/?$/iu.test(trimmed);
}
function normalizeCodexTransportFields(params) {
	const useCodexTransport = !params.baseUrl || isOpenAIApiBaseUrl(params.baseUrl) || isOpenAICodexBaseUrl(params.baseUrl) || isLegacyCodexCompatBaseUrl(params.baseUrl);
	const api = useCodexTransport && (!params.api || params.api === "openai-responses" || params.api === "openai-completions") ? "openai-codex-responses" : params.api ?? void 0;
	return {
		api,
		baseUrl: api === "openai-codex-responses" && useCodexTransport ? OPENAI_CODEX_BASE_URL : params.baseUrl
	};
}
function hasImageInput(input) {
	return Array.isArray(input) && input.includes("image");
}
function matchesOpenAICodexImageCapableModel(modelId, modelName) {
	return [modelId, modelName].filter((value) => typeof value === "string").some((candidate) => matchesExactOrPrefix(candidate, OPENAI_CODEX_MODERN_MODEL_IDS));
}
/**
* Restore native `["text", "image"]` input capability on resolved Codex rows
* for the known modern model IDs (gpt-5.4, gpt-5.4-mini, gpt-5.4-pro, gpt-5.5,
* gpt-5.5-pro). Persisted/configured model rows can omit the `input` field
* entirely when they were written by older OpenClaw versions. When that row wins
* the catalog merge, `modelSupportsInput(entry, "image")` returns false and the
* gateway's `chat.send` handler offloads inbound images as `media://inbound/<id>`
* claim-check URIs instead of inlining them.
*
* Mirrors the Anthropic precedent set by upstream #83756.
*/
function applyOpenAICodexImageInputCapability(params) {
	if (hasImageInput(params.model.input)) return;
	if (!matchesOpenAICodexImageCapableModel(params.modelId, params.model.name)) return;
	return {
		...params.model,
		input: ["text", "image"]
	};
}
function normalizeCodexTransport(model) {
	const canonicalModelId = normalizeLowercaseStringOrEmpty(model.id) === OPENAI_CODEX_GPT_54_LEGACY_MODEL_ID ? OPENAI_CODEX_GPT_54_MODEL_ID : model.id;
	const canonicalName = normalizeLowercaseStringOrEmpty(model.name) === OPENAI_CODEX_GPT_54_LEGACY_MODEL_ID ? OPENAI_CODEX_GPT_54_MODEL_ID : model.name;
	const normalizedTransport = normalizeCodexTransportFields({
		api: model.api,
		baseUrl: model.baseUrl
	});
	const api = normalizedTransport.api ?? model.api;
	const baseUrl = normalizedTransport.baseUrl ?? model.baseUrl;
	if (api === model.api && baseUrl === model.baseUrl && canonicalModelId === model.id && canonicalName === model.name) return model;
	return {
		...model,
		id: canonicalModelId,
		name: canonicalName,
		api,
		baseUrl
	};
}
function resolveCodexForwardCompatModel(ctx) {
	const trimmedModelId = ctx.modelId.trim();
	const lower = normalizeLowercaseStringOrEmpty(trimmedModelId);
	const synthBaseUrl = ctx.providerConfig?.baseUrl ?? OPENAI_CODEX_BASE_URL;
	if (lower === OPENAI_CODEX_GPT_55_MODEL_ID) return withDefaultCodexContextMetadata({
		model: ctx.modelRegistry.find(PROVIDER_ID, trimmedModelId),
		contextWindow: OPENAI_CODEX_GPT_55_CODEX_CONTEXT_TOKENS,
		contextTokens: OPENAI_CODEX_GPT_55_DEFAULT_RUNTIME_CONTEXT_TOKENS
	}) ?? normalizeModelCompat({
		id: trimmedModelId,
		name: trimmedModelId,
		api: "openai-codex-responses",
		provider: PROVIDER_ID,
		baseUrl: synthBaseUrl,
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0
		},
		contextWindow: OPENAI_CODEX_GPT_55_CODEX_CONTEXT_TOKENS,
		contextTokens: OPENAI_CODEX_GPT_55_DEFAULT_RUNTIME_CONTEXT_TOKENS,
		maxTokens: OPENAI_CODEX_GPT_54_MAX_TOKENS
	});
	let templateIds;
	let patch;
	if (lower === OPENAI_CODEX_GPT_55_PRO_MODEL_ID) {
		templateIds = OPENAI_CODEX_GPT_55_PRO_TEMPLATE_MODEL_IDS;
		patch = {
			contextWindow: OPENAI_CODEX_GPT_55_PRO_NATIVE_CONTEXT_TOKENS,
			contextTokens: OPENAI_CODEX_GPT_55_PRO_DEFAULT_CONTEXT_TOKENS,
			maxTokens: OPENAI_CODEX_GPT_54_MAX_TOKENS,
			cost: OPENAI_CODEX_GPT_55_PRO_COST
		};
	} else if (lower === OPENAI_CODEX_GPT_54_MODEL_ID || lower === OPENAI_CODEX_GPT_54_LEGACY_MODEL_ID) {
		templateIds = OPENAI_CODEX_GPT_54_CATALOG_SYNTH_TEMPLATE_MODEL_IDS;
		patch = {
			contextWindow: OPENAI_CODEX_GPT_54_NATIVE_CONTEXT_TOKENS,
			contextTokens: OPENAI_CODEX_GPT_54_DEFAULT_CONTEXT_TOKENS,
			maxTokens: OPENAI_CODEX_GPT_54_MAX_TOKENS,
			cost: OPENAI_CODEX_GPT_54_COST
		};
	} else if (lower === OPENAI_CODEX_GPT_54_PRO_MODEL_ID) {
		templateIds = OPENAI_CODEX_GPT_54_CATALOG_SYNTH_TEMPLATE_MODEL_IDS;
		patch = {
			contextWindow: OPENAI_CODEX_GPT_54_NATIVE_CONTEXT_TOKENS,
			contextTokens: OPENAI_CODEX_GPT_54_DEFAULT_CONTEXT_TOKENS,
			maxTokens: OPENAI_CODEX_GPT_54_MAX_TOKENS,
			cost: OPENAI_CODEX_GPT_54_PRO_COST
		};
	} else if (lower === OPENAI_CODEX_GPT_54_MINI_MODEL_ID) {
		templateIds = OPENAI_CODEX_GPT_54_CATALOG_SYNTH_TEMPLATE_MODEL_IDS;
		patch = {
			contextWindow: OPENAI_CODEX_GPT_54_MINI_NATIVE_CONTEXT_TOKENS,
			contextTokens: OPENAI_CODEX_GPT_54_DEFAULT_CONTEXT_TOKENS,
			maxTokens: OPENAI_CODEX_GPT_54_MAX_TOKENS,
			cost: OPENAI_CODEX_GPT_54_MINI_COST
		};
	} else return;
	return cloneFirstTemplateModel({
		providerId: PROVIDER_ID,
		modelId: lower === OPENAI_CODEX_GPT_54_LEGACY_MODEL_ID ? OPENAI_CODEX_GPT_54_MODEL_ID : trimmedModelId,
		templateIds,
		ctx,
		patch
	}) ?? normalizeModelCompat({
		id: lower === OPENAI_CODEX_GPT_54_LEGACY_MODEL_ID ? OPENAI_CODEX_GPT_54_MODEL_ID : trimmedModelId,
		name: lower === OPENAI_CODEX_GPT_54_LEGACY_MODEL_ID ? OPENAI_CODEX_GPT_54_MODEL_ID : trimmedModelId,
		api: "openai-codex-responses",
		provider: PROVIDER_ID,
		baseUrl: synthBaseUrl,
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0
		},
		contextWindow: patch?.contextWindow ?? 2e5,
		contextTokens: patch?.contextTokens,
		maxTokens: patch?.maxTokens ?? 2e5
	});
}
function withDefaultCodexContextMetadata(params) {
	if (!params.model) return;
	const contextTokens = typeof params.model.contextTokens === "number" ? params.model.contextTokens : typeof params.model.contextWindow === "number" && params.model.contextWindow > 0 ? Math.min(params.contextTokens, params.model.contextWindow) : params.contextTokens;
	const input = params.model.input?.includes("image") ? params.model.input : [...new Set([...params.model.input ?? ["text"], "image"])];
	return {
		...params.model,
		input,
		contextWindow: params.contextWindow,
		contextTokens
	};
}
function buildCodexCredentialExtra(identity) {
	const extra = {
		...identity.accountId ? { accountId: identity.accountId } : {},
		...identity.chatgptPlanType ? { chatgptPlanType: identity.chatgptPlanType } : {}
	};
	return Object.keys(extra).length > 0 ? extra : void 0;
}
function buildOpenAICodexAuthConfigPatch() {
	return { agents: { defaults: { models: { [OPENAI_CODEX_DEFAULT_MODEL]: {} } } } };
}
function applyOpenAICodexAuthConfig(cfg) {
	return {
		...cfg,
		agents: {
			...cfg.agents,
			defaults: {
				...cfg.agents?.defaults,
				models: {
					...cfg.agents?.defaults?.models,
					[OPENAI_CODEX_DEFAULT_MODEL]: {}
				}
			}
		}
	};
}
async function refreshOpenAICodexOAuthCredential(cred) {
	try {
		const { refreshOpenAICodexToken } = await import("./extensions/openai/openai-codex-provider.runtime.js");
		const refreshed = await refreshOpenAICodexToken(cred.refresh);
		const identity = resolveCodexAuthIdentity({
			accessToken: refreshed.access,
			email: cred.email
		});
		return {
			...cred,
			...refreshed,
			type: "oauth",
			provider: PROVIDER_ID,
			email: identity.email ?? cred.email,
			displayName: cred.displayName,
			...buildCodexCredentialExtra(identity)
		};
	} catch (error) {
		const message = formatErrorMessage(error);
		if (/extract\s+accountid\s+from\s+token/i.test(message) && typeof cred.access === "string" && cred.access.trim().length > 0) return cred;
		throw error;
	}
}
async function runOpenAICodexOAuth(ctx) {
	const creds = await loginOpenAICodexOAuth({
		prompter: ctx.prompter,
		runtime: ctx.runtime,
		oauth: ctx.oauth,
		isRemote: ctx.isRemote,
		openUrl: ctx.openUrl,
		localBrowserMessage: "Complete sign-in in browser…"
	});
	if (!creds) return { profiles: [] };
	const identity = resolveCodexAuthIdentity({
		accessToken: creds.access,
		email: readStringValue(creds.email)
	});
	return buildOauthProviderAuthResult({
		providerId: PROVIDER_ID,
		defaultModel: OPENAI_CODEX_DEFAULT_MODEL,
		configPatch: buildOpenAICodexAuthConfigPatch(),
		access: creds.access,
		refresh: creds.refresh,
		expires: creds.expires,
		email: identity.email,
		profileName: identity.profileName,
		credentialExtra: buildCodexCredentialExtra(identity)
	});
}
async function runOpenAICodexDeviceCode(ctx) {
	const spin = ctx.prompter.progress("Starting device code flow…");
	try {
		const creds = await loginOpenAICodexDeviceCode({
			onProgress: (message) => spin.update(message),
			onVerification: async ({ verificationUrl, userCode, expiresInMs }) => {
				const expiresInMinutes = Math.max(1, Math.round(expiresInMs / 6e4));
				await ctx.prompter.note([
					ctx.isRemote ? "Open this URL in your LOCAL browser and enter the code below." : "Open this URL in your browser and enter the code below.",
					`URL: ${verificationUrl}`,
					`Code: ${userCode}`,
					`Code expires in ${expiresInMinutes} minutes. Never share it.`
				].join("\n"), "OpenAI Codex device code");
				if (ctx.isRemote) {
					ctx.runtime.log(`\nOpen this URL in your LOCAL browser:\n\n${verificationUrl}\n`);
					return;
				}
				try {
					await ctx.openUrl(verificationUrl);
					ctx.runtime.log(`Open: ${verificationUrl}`);
				} catch {
					ctx.runtime.log(`Open manually: ${verificationUrl}`);
				}
			}
		});
		spin.stop("OpenAI device code complete");
		const identity = resolveCodexAuthIdentity({ accessToken: creds.access });
		return buildOauthProviderAuthResult({
			providerId: PROVIDER_ID,
			defaultModel: OPENAI_CODEX_DEFAULT_MODEL,
			configPatch: buildOpenAICodexAuthConfigPatch(),
			access: creds.access,
			refresh: creds.refresh,
			expires: creds.expires,
			email: identity.email,
			profileName: identity.profileName,
			credentialExtra: buildCodexCredentialExtra(identity)
		});
	} catch (error) {
		spin.stop("OpenAI device code failed");
		ctx.runtime.error(formatErrorMessage(error));
		await ctx.prompter.note("Trouble with device code login? See https://docs.openclaw.ai/start/faq", "OAuth help");
		throw error;
	}
}
function buildOpenAICodexAuthDoctorHint(ctx) {
	if (ctx.profileId !== "openai-codex:codex-cli") return;
	return "Deprecated profile. Run `openclaw models auth login --provider openai-codex` or `openclaw configure`.";
}
function buildOpenAICodexProviderPlugin() {
	return {
		id: PROVIDER_ID,
		label: "OpenAI Codex",
		docsPath: "/providers/models",
		oauthProfileIdRepairs: [{
			legacyProfileId: "openai-codex:default",
			promptLabel: "OpenAI Codex"
		}],
		auth: [
			{
				id: "oauth",
				label: OPENAI_CODEX_LOGIN_LABEL,
				hint: OPENAI_CODEX_LOGIN_HINT,
				kind: "oauth",
				wizard: {
					choiceId: "openai-codex",
					choiceLabel: OPENAI_CODEX_LOGIN_LABEL,
					choiceHint: OPENAI_CODEX_LOGIN_HINT,
					assistantPriority: OPENAI_CODEX_LOGIN_ASSISTANT_PRIORITY,
					onboardingFeatured: true,
					...OPENAI_CODEX_WIZARD_GROUP
				},
				run: async (ctx) => await runOpenAICodexOAuth(ctx)
			},
			{
				id: "device-code",
				label: OPENAI_CODEX_DEVICE_PAIRING_LABEL,
				hint: OPENAI_CODEX_DEVICE_PAIRING_HINT,
				kind: "device_code",
				wizard: {
					choiceId: "openai-codex-device-code",
					choiceLabel: OPENAI_CODEX_DEVICE_PAIRING_LABEL,
					choiceHint: OPENAI_CODEX_DEVICE_PAIRING_HINT,
					assistantPriority: OPENAI_CODEX_DEVICE_PAIRING_ASSISTANT_PRIORITY,
					...OPENAI_CODEX_WIZARD_GROUP
				},
				run: async (ctx) => await runOpenAICodexDeviceCode(ctx)
			},
			createProviderApiKeyAuthMethod({
				providerId: OPENAI_PROVIDER_ID,
				methodId: "api-key",
				label: OPENAI_CODEX_API_KEY_BACKUP_LABEL,
				hint: OPENAI_CODEX_API_KEY_BACKUP_HINT,
				optionKey: "openaiApiKey",
				flagName: "--openai-api-key",
				envVar: "OPENAI_API_KEY",
				promptMessage: "Enter OpenAI API key",
				profileId: "openai:default",
				defaultModel: OPENAI_CODEX_DEFAULT_MODEL,
				expectedProviders: [OPENAI_PROVIDER_ID],
				applyConfig: applyOpenAICodexAuthConfig,
				wizard: {
					choiceId: "openai-codex-api-key",
					choiceLabel: OPENAI_CODEX_API_KEY_BACKUP_LABEL,
					choiceHint: OPENAI_CODEX_API_KEY_BACKUP_HINT,
					assistantPriority: 5,
					assistantVisibility: "manual-only",
					...OPENAI_CODEX_WIZARD_GROUP
				}
			})
		],
		catalog: {
			order: "profile",
			run: async (ctx) => {
				if (listProfilesForProvider(ensureAuthProfileStoreForLocalUpdate(ctx.agentDir), PROVIDER_ID).length === 0) return null;
				return { provider: buildOpenAICodexProvider() };
			}
		},
		resolveDynamicModel: (ctx) => resolveCodexForwardCompatModel(ctx),
		buildAuthDoctorHint: (ctx) => buildOpenAICodexAuthDoctorHint(ctx),
		resolveThinkingProfile: ({ modelId }) => resolveOpenAICodexThinkingProfile(modelId),
		isModernModelRef: ({ modelId }) => matchesExactOrPrefix(modelId, OPENAI_CODEX_MODERN_MODEL_IDS),
		preferRuntimeResolvedModel: (ctx) => {
			if (normalizeProviderId(ctx.provider) !== PROVIDER_ID) return false;
			const id = ctx.modelId.trim().toLowerCase();
			return [
				OPENAI_CODEX_GPT_55_MODEL_ID,
				OPENAI_CODEX_GPT_55_PRO_MODEL_ID,
				OPENAI_CODEX_GPT_54_MODEL_ID,
				OPENAI_CODEX_GPT_54_PRO_MODEL_ID,
				OPENAI_CODEX_GPT_54_MINI_MODEL_ID
			].includes(id);
		},
		...buildOpenAIResponsesProviderHooks(),
		resolveReasoningOutputMode: () => "native",
		normalizeResolvedModel: (ctx) => {
			if (normalizeProviderId(ctx.provider) !== PROVIDER_ID) return;
			const transportNormalized = normalizeCodexTransport(ctx.model);
			const imageCapable = applyOpenAICodexImageInputCapability({
				modelId: ctx.modelId,
				model: transportNormalized
			}) ?? transportNormalized;
			return imageCapable === ctx.model ? void 0 : imageCapable;
		},
		normalizeTransport: ({ provider, api, baseUrl }) => {
			if (normalizeProviderId(provider) !== PROVIDER_ID) return;
			const normalized = normalizeCodexTransportFields({
				api,
				baseUrl
			});
			if (normalized.api === api && normalized.baseUrl === baseUrl) return;
			return normalized;
		},
		resolveUsageAuth: async (ctx) => await ctx.resolveOAuthToken(),
		fetchUsageSnapshot: async (ctx) => await fetchCodexUsage(ctx.token, ctx.accountId, ctx.timeoutMs, ctx.fetchFn),
		refreshOAuth: async (cred) => await refreshOpenAICodexOAuthCredential(cred),
		augmentModelCatalog: (ctx) => {
			const gpt54Template = findCatalogTemplate({
				entries: ctx.entries,
				providerId: PROVIDER_ID,
				templateIds: OPENAI_CODEX_GPT_54_CATALOG_SYNTH_TEMPLATE_MODEL_IDS
			});
			return [
				buildOpenAISyntheticCatalogEntry(findCatalogTemplate({
					entries: ctx.entries,
					providerId: PROVIDER_ID,
					templateIds: OPENAI_CODEX_GPT_55_PRO_TEMPLATE_MODEL_IDS
				}), {
					id: OPENAI_CODEX_GPT_55_PRO_MODEL_ID,
					reasoning: true,
					input: ["text", "image"],
					contextWindow: OPENAI_CODEX_GPT_55_PRO_NATIVE_CONTEXT_TOKENS,
					contextTokens: OPENAI_CODEX_GPT_55_PRO_DEFAULT_CONTEXT_TOKENS,
					cost: OPENAI_CODEX_GPT_55_PRO_COST
				}),
				buildOpenAISyntheticCatalogEntry(gpt54Template, {
					id: OPENAI_CODEX_GPT_54_MODEL_ID,
					reasoning: true,
					input: ["text", "image"],
					contextWindow: OPENAI_CODEX_GPT_54_NATIVE_CONTEXT_TOKENS,
					contextTokens: OPENAI_CODEX_GPT_54_DEFAULT_CONTEXT_TOKENS,
					cost: OPENAI_CODEX_GPT_54_COST
				}),
				buildOpenAISyntheticCatalogEntry(gpt54Template, {
					id: OPENAI_CODEX_GPT_54_PRO_MODEL_ID,
					reasoning: true,
					input: ["text", "image"],
					contextWindow: OPENAI_CODEX_GPT_54_NATIVE_CONTEXT_TOKENS,
					contextTokens: OPENAI_CODEX_GPT_54_DEFAULT_CONTEXT_TOKENS,
					cost: OPENAI_CODEX_GPT_54_PRO_COST
				}),
				buildOpenAISyntheticCatalogEntry(gpt54Template, {
					id: OPENAI_CODEX_GPT_54_MINI_MODEL_ID,
					reasoning: true,
					input: ["text", "image"],
					contextWindow: OPENAI_CODEX_GPT_54_MINI_NATIVE_CONTEXT_TOKENS,
					contextTokens: OPENAI_CODEX_GPT_54_DEFAULT_CONTEXT_TOKENS,
					cost: OPENAI_CODEX_GPT_54_MINI_COST
				})
			].filter((entry) => entry !== void 0);
		}
	};
}
//#endregion
export { buildOpenAICodexProviderPlugin as t };
