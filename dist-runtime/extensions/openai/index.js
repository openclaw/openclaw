import "../../provider-env-vars-BfZUtZAn.js";
import { t as emptyPluginConfigSchema } from "../../config-schema-DpOJkOlS.js";
import "../../resolve-route-BZ4hHpx2.js";
import { t as formatCliCommand } from "../../command-format-ZZqKRRhR.js";
import "../../logger-CRwcgB9y.js";
import "../../tmp-openclaw-dir-Bz3ouN_i.js";
import "../../paths-Byjx7_T6.js";
import "../../subsystem-CsP80x3t.js";
import "../../utils-o1tyfnZ_.js";
import "../../fetch-Dx857jUp.js";
import "../../retry-BY_ggjbn.js";
import { t as buildOauthProviderAuthResult } from "../../provider-auth-result-BwNanZxe.js";
import "../../agent-scope-DV_aCIyi.js";
import "../../exec-BLi45_38.js";
import "../../logger-Bsnck4bK.js";
import "../../core-qWFcsWSH.js";
import { m as CODEX_CLI_PROFILE_ID } from "../../paths-OqPpu-UR.js";
import { Gl as ensureModelAllowlistEntry, Or as normalizeModelCompat } from "../../auth-profiles-CuJtivJK.js";
import { a as ensureAuthProfileStore, l as normalizeProviderId, n as listProfilesForProvider } from "../../profiles-CV7WLKIX.js";
import "../../fetch-D2ZOzaXt.js";
import "../../external-content-vZzOHxnd.js";
import "../../kilocode-shared-Ci8SRxXc.js";
import { h as buildOpenAICodexProvider } from "../../models-config.providers.static-DRBnLpDj.js";
import "../../models-config.providers.discovery-l-LpSxGW.js";
import "../../pairing-token-DKpN4qO0.js";
import "../../query-expansion-txqQdNIf.js";
import "../../redact-BefI-5cC.js";
import "../../mime-33LCeGh-.js";
import "../../typebox-BmZP6XXv.js";
import "../../web-search-plugin-factory-DStYVW2B.js";
import "../../provider-usage.fetch.shared-4in1kuRh.js";
import { i as fetchCodexUsage } from "../../provider-usage.fetch-CT9bwlMB.js";
import { t as createProviderApiKeyAuthMethod } from "../../provider-api-key-auth-C_oZ2YEn.js";
import path from "node:path";
import "@clack/prompts";
import { getOAuthApiKey, loginOpenAICodex } from "@mariozechner/pi-ai/oauth";
//#region src/commands/oauth-flow.ts
const validateRequiredInput = (value) => value.trim().length > 0 ? void 0 : "Required";
function createVpsAwareOAuthHandlers(params) {
	const manualPromptMessage = params.manualPromptMessage ?? "Paste the redirect URL";
	let manualCodePromise;
	return {
		onAuth: async ({ url }) => {
			if (params.isRemote) {
				params.spin.stop("OAuth URL ready");
				params.runtime.log(`\nOpen this URL in your LOCAL browser:\n\n${url}\n`);
				manualCodePromise = params.prompter.text({
					message: manualPromptMessage,
					validate: validateRequiredInput
				}).then((value) => String(value));
				return;
			}
			params.spin.update(params.localBrowserMessage);
			await params.openUrl(url);
			params.runtime.log(`Open: ${url}`);
		},
		onPrompt: async (prompt) => {
			if (manualCodePromise) return manualCodePromise;
			const code = await params.prompter.text({
				message: prompt.message,
				placeholder: prompt.placeholder,
				validate: validateRequiredInput
			});
			return String(code);
		}
	};
}
//#endregion
//#region src/commands/oauth-tls-preflight.ts
const TLS_CERT_ERROR_CODES = new Set([
	"UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
	"UNABLE_TO_VERIFY_LEAF_SIGNATURE",
	"CERT_HAS_EXPIRED",
	"DEPTH_ZERO_SELF_SIGNED_CERT",
	"SELF_SIGNED_CERT_IN_CHAIN",
	"ERR_TLS_CERT_ALTNAME_INVALID"
]);
const TLS_CERT_ERROR_PATTERNS = [
	/unable to get local issuer certificate/i,
	/unable to verify the first certificate/i,
	/self[- ]signed certificate/i,
	/certificate has expired/i
];
const OPENAI_AUTH_PROBE_URL = "https://auth.openai.com/oauth/authorize?response_type=code&client_id=openclaw-preflight&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid+profile+email";
function asRecord(value) {
	return value && typeof value === "object" ? value : null;
}
function extractFailure(error) {
	const root = asRecord(error);
	const rootCause = asRecord(root?.cause);
	const code = typeof rootCause?.code === "string" ? rootCause.code : void 0;
	const message = typeof rootCause?.message === "string" ? rootCause.message : typeof root?.message === "string" ? root.message : String(error);
	return {
		code,
		message,
		kind: (code ? TLS_CERT_ERROR_CODES.has(code) : false) || TLS_CERT_ERROR_PATTERNS.some((pattern) => pattern.test(message)) ? "tls-cert" : "network"
	};
}
function resolveHomebrewPrefixFromExecPath(execPath) {
	const marker = `${path.sep}Cellar${path.sep}`;
	const idx = execPath.indexOf(marker);
	if (idx > 0) return execPath.slice(0, idx);
	const envPrefix = process.env.HOMEBREW_PREFIX?.trim();
	return envPrefix ? envPrefix : null;
}
function resolveCertBundlePath() {
	const prefix = resolveHomebrewPrefixFromExecPath(process.execPath);
	if (!prefix) return null;
	return path.join(prefix, "etc", "openssl@3", "cert.pem");
}
async function runOpenAIOAuthTlsPreflight(options) {
	const timeoutMs = options?.timeoutMs ?? 5e3;
	const fetchImpl = options?.fetchImpl ?? fetch;
	try {
		await fetchImpl(OPENAI_AUTH_PROBE_URL, {
			method: "GET",
			redirect: "manual",
			signal: AbortSignal.timeout(timeoutMs)
		});
		return { ok: true };
	} catch (error) {
		const failure = extractFailure(error);
		return {
			ok: false,
			kind: failure.kind,
			code: failure.code,
			message: failure.message
		};
	}
}
function formatOpenAIOAuthTlsPreflightFix(result) {
	if (result.kind !== "tls-cert") return [
		"OpenAI OAuth prerequisites check failed due to a network error before the browser flow.",
		`Cause: ${result.message}`,
		"Verify DNS/firewall/proxy access to auth.openai.com and retry."
	].join("\n");
	const certBundlePath = resolveCertBundlePath();
	const lines = [
		"OpenAI OAuth prerequisites check failed: Node/OpenSSL cannot validate TLS certificates.",
		`Cause: ${result.code ? `${result.code} (${result.message})` : result.message}`,
		"",
		"Fix (Homebrew Node/OpenSSL):",
		`- ${formatCliCommand("brew postinstall ca-certificates")}`,
		`- ${formatCliCommand("brew postinstall openssl@3")}`
	];
	if (certBundlePath) lines.push(`- Verify cert bundle exists: ${certBundlePath}`);
	lines.push("- Retry the OAuth login flow.");
	return lines.join("\n");
}
//#endregion
//#region src/commands/openai-codex-oauth.ts
async function loginOpenAICodexOAuth(params) {
	const { prompter, runtime, isRemote, openUrl, localBrowserMessage } = params;
	const preflight = await runOpenAIOAuthTlsPreflight();
	if (!preflight.ok && preflight.kind === "tls-cert") {
		const hint = formatOpenAIOAuthTlsPreflightFix(preflight);
		runtime.error(hint);
		await prompter.note(hint, "OAuth prerequisites");
		throw new Error(preflight.message);
	}
	await prompter.note(isRemote ? [
		"You are running in a remote/VPS environment.",
		"A URL will be shown for you to open in your LOCAL browser.",
		"After signing in, paste the redirect URL back here."
	].join("\n") : [
		"Browser will open for OpenAI authentication.",
		"If the callback doesn't auto-complete, paste the redirect URL.",
		"OpenAI OAuth uses localhost:1455 for the callback."
	].join("\n"), "OpenAI Codex OAuth");
	const spin = prompter.progress("Starting OAuth flow…");
	try {
		const { onAuth: baseOnAuth, onPrompt } = createVpsAwareOAuthHandlers({
			isRemote,
			prompter,
			runtime,
			spin,
			openUrl,
			localBrowserMessage: localBrowserMessage ?? "Complete sign-in in browser…"
		});
		const creds = await loginOpenAICodex({
			onAuth: baseOnAuth,
			onPrompt,
			onProgress: (msg) => spin.update(msg)
		});
		spin.stop("OpenAI OAuth complete");
		return creds ?? null;
	} catch (err) {
		spin.stop("OpenAI OAuth failed");
		runtime.error(String(err));
		await prompter.note("Trouble with OAuth? See https://docs.openclaw.ai/start/faq", "OAuth help");
		throw err;
	}
}
//#endregion
//#region extensions/openai/shared.ts
function matchesExactOrPrefix(id, values) {
	const normalizedId = id.trim().toLowerCase();
	return values.some((value) => {
		const normalizedValue = value.trim().toLowerCase();
		return normalizedId === normalizedValue || normalizedId.startsWith(normalizedValue);
	});
}
function isOpenAIApiBaseUrl(baseUrl) {
	const trimmed = baseUrl?.trim();
	if (!trimmed) return false;
	return /^https?:\/\/api\.openai\.com(?:\/v1)?\/?$/i.test(trimmed);
}
function cloneFirstTemplateModel(params) {
	const trimmedModelId = params.modelId.trim();
	for (const templateId of [...new Set(params.templateIds)].filter(Boolean)) {
		const template = params.ctx.modelRegistry.find(params.providerId, templateId);
		if (!template) continue;
		return normalizeModelCompat({
			...template,
			id: trimmedModelId,
			name: trimmedModelId,
			...params.patch
		});
	}
}
function findCatalogTemplate(params) {
	return params.templateIds.map((templateId) => params.entries.find((entry) => entry.provider.toLowerCase() === params.providerId.toLowerCase() && entry.id.toLowerCase() === templateId.toLowerCase())).find((entry) => entry !== void 0);
}
//#endregion
//#region extensions/openai/openai-codex-provider.ts
const PROVIDER_ID$1 = "openai-codex";
const OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const OPENAI_CODEX_GPT_54_MODEL_ID = "gpt-5.4";
const OPENAI_CODEX_GPT_54_CONTEXT_TOKENS = 105e4;
const OPENAI_CODEX_GPT_54_MAX_TOKENS = 128e3;
const OPENAI_CODEX_GPT_54_TEMPLATE_MODEL_IDS = ["gpt-5.3-codex", "gpt-5.2-codex"];
const OPENAI_CODEX_GPT_53_MODEL_ID = "gpt-5.3-codex";
const OPENAI_CODEX_GPT_53_SPARK_MODEL_ID = "gpt-5.3-codex-spark";
const OPENAI_CODEX_GPT_53_SPARK_CONTEXT_TOKENS = 128e3;
const OPENAI_CODEX_GPT_53_SPARK_MAX_TOKENS = 128e3;
const OPENAI_CODEX_TEMPLATE_MODEL_IDS = ["gpt-5.2-codex"];
const OPENAI_CODEX_DEFAULT_MODEL = `${PROVIDER_ID$1}/${OPENAI_CODEX_GPT_54_MODEL_ID}`;
const OPENAI_CODEX_XHIGH_MODEL_IDS = [
	OPENAI_CODEX_GPT_54_MODEL_ID,
	OPENAI_CODEX_GPT_53_MODEL_ID,
	OPENAI_CODEX_GPT_53_SPARK_MODEL_ID,
	"gpt-5.2-codex",
	"gpt-5.1-codex"
];
const OPENAI_CODEX_MODERN_MODEL_IDS = [
	OPENAI_CODEX_GPT_54_MODEL_ID,
	"gpt-5.2",
	"gpt-5.2-codex",
	OPENAI_CODEX_GPT_53_MODEL_ID,
	OPENAI_CODEX_GPT_53_SPARK_MODEL_ID,
	"gpt-5.1-codex",
	"gpt-5.1-codex-mini",
	"gpt-5.1-codex-max"
];
function isOpenAICodexBaseUrl(baseUrl) {
	const trimmed = baseUrl?.trim();
	if (!trimmed) return false;
	return /^https?:\/\/chatgpt\.com\/backend-api\/?$/i.test(trimmed);
}
function normalizeCodexTransport(model) {
	const api = (!model.baseUrl || isOpenAIApiBaseUrl(model.baseUrl) || isOpenAICodexBaseUrl(model.baseUrl)) && model.api === "openai-responses" ? "openai-codex-responses" : model.api;
	const baseUrl = api === "openai-codex-responses" && (!model.baseUrl || isOpenAIApiBaseUrl(model.baseUrl)) ? OPENAI_CODEX_BASE_URL : model.baseUrl;
	if (api === model.api && baseUrl === model.baseUrl) return model;
	return {
		...model,
		api,
		baseUrl
	};
}
function resolveCodexForwardCompatModel(ctx) {
	const trimmedModelId = ctx.modelId.trim();
	const lower = trimmedModelId.toLowerCase();
	let templateIds;
	let patch;
	if (lower === OPENAI_CODEX_GPT_54_MODEL_ID) {
		templateIds = OPENAI_CODEX_GPT_54_TEMPLATE_MODEL_IDS;
		patch = {
			contextWindow: OPENAI_CODEX_GPT_54_CONTEXT_TOKENS,
			maxTokens: OPENAI_CODEX_GPT_54_MAX_TOKENS
		};
	} else if (lower === OPENAI_CODEX_GPT_53_SPARK_MODEL_ID) {
		templateIds = [OPENAI_CODEX_GPT_53_MODEL_ID, ...OPENAI_CODEX_TEMPLATE_MODEL_IDS];
		patch = {
			api: "openai-codex-responses",
			provider: PROVIDER_ID$1,
			baseUrl: OPENAI_CODEX_BASE_URL,
			reasoning: true,
			input: ["text"],
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0
			},
			contextWindow: OPENAI_CODEX_GPT_53_SPARK_CONTEXT_TOKENS,
			maxTokens: OPENAI_CODEX_GPT_53_SPARK_MAX_TOKENS
		};
	} else if (lower === OPENAI_CODEX_GPT_53_MODEL_ID) templateIds = OPENAI_CODEX_TEMPLATE_MODEL_IDS;
	else return;
	return cloneFirstTemplateModel({
		providerId: PROVIDER_ID$1,
		modelId: trimmedModelId,
		templateIds,
		ctx,
		patch
	}) ?? normalizeModelCompat({
		id: trimmedModelId,
		name: trimmedModelId,
		api: "openai-codex-responses",
		provider: PROVIDER_ID$1,
		baseUrl: OPENAI_CODEX_BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0
		},
		contextWindow: patch?.contextWindow ?? 2e5,
		maxTokens: patch?.maxTokens ?? 2e5
	});
}
async function refreshOpenAICodexOAuthCredential(cred) {
	try {
		const refreshed = await getOAuthApiKey("openai-codex", { "openai-codex": cred });
		if (!refreshed) throw new Error("OpenAI Codex OAuth refresh returned no credentials.");
		return {
			...cred,
			...refreshed.newCredentials,
			type: "oauth",
			provider: PROVIDER_ID$1,
			email: cred.email
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (/extract\s+accountid\s+from\s+token/i.test(message) && typeof cred.access === "string" && cred.access.trim().length > 0) return cred;
		throw error;
	}
}
async function runOpenAICodexOAuth(ctx) {
	let creds;
	try {
		creds = await loginOpenAICodexOAuth({
			prompter: ctx.prompter,
			runtime: ctx.runtime,
			isRemote: ctx.isRemote,
			openUrl: ctx.openUrl,
			localBrowserMessage: "Complete sign-in in browser…"
		});
	} catch {
		return { profiles: [] };
	}
	if (!creds) return { profiles: [] };
	return buildOauthProviderAuthResult({
		providerId: PROVIDER_ID$1,
		defaultModel: OPENAI_CODEX_DEFAULT_MODEL,
		access: creds.access,
		refresh: creds.refresh,
		expires: creds.expires,
		email: typeof creds.email === "string" ? creds.email : void 0
	});
}
function buildOpenAICodexProviderPlugin() {
	return {
		id: PROVIDER_ID$1,
		label: "OpenAI Codex",
		docsPath: "/providers/models",
		deprecatedProfileIds: [CODEX_CLI_PROFILE_ID],
		auth: [{
			id: "oauth",
			label: "ChatGPT OAuth",
			hint: "Browser sign-in",
			kind: "oauth",
			run: async (ctx) => await runOpenAICodexOAuth(ctx)
		}],
		wizard: { setup: {
			choiceId: "openai-codex",
			choiceLabel: "OpenAI Codex (ChatGPT OAuth)",
			choiceHint: "Browser sign-in",
			methodId: "oauth"
		} },
		catalog: {
			order: "profile",
			run: async (ctx) => {
				if (listProfilesForProvider(ensureAuthProfileStore(ctx.agentDir, { allowKeychainPrompt: false }), PROVIDER_ID$1).length === 0) return null;
				return { provider: buildOpenAICodexProvider() };
			}
		},
		resolveDynamicModel: (ctx) => resolveCodexForwardCompatModel(ctx),
		capabilities: { providerFamily: "openai" },
		supportsXHighThinking: ({ modelId }) => matchesExactOrPrefix(modelId, OPENAI_CODEX_XHIGH_MODEL_IDS),
		isModernModelRef: ({ modelId }) => matchesExactOrPrefix(modelId, OPENAI_CODEX_MODERN_MODEL_IDS),
		prepareExtraParams: (ctx) => {
			const transport = ctx.extraParams?.transport;
			if (transport === "auto" || transport === "sse" || transport === "websocket") return ctx.extraParams;
			return {
				...ctx.extraParams,
				transport: "auto"
			};
		},
		normalizeResolvedModel: (ctx) => {
			if (normalizeProviderId(ctx.provider) !== PROVIDER_ID$1) return;
			return normalizeCodexTransport(ctx.model);
		},
		resolveUsageAuth: async (ctx) => await ctx.resolveOAuthToken(),
		fetchUsageSnapshot: async (ctx) => await fetchCodexUsage(ctx.token, ctx.accountId, ctx.timeoutMs, ctx.fetchFn),
		refreshOAuth: async (cred) => await refreshOpenAICodexOAuthCredential(cred),
		augmentModelCatalog: (ctx) => {
			const gpt54Template = findCatalogTemplate({
				entries: ctx.entries,
				providerId: PROVIDER_ID$1,
				templateIds: OPENAI_CODEX_GPT_54_TEMPLATE_MODEL_IDS
			});
			const sparkTemplate = findCatalogTemplate({
				entries: ctx.entries,
				providerId: PROVIDER_ID$1,
				templateIds: [OPENAI_CODEX_GPT_53_MODEL_ID, ...OPENAI_CODEX_TEMPLATE_MODEL_IDS]
			});
			return [gpt54Template ? {
				...gpt54Template,
				id: OPENAI_CODEX_GPT_54_MODEL_ID,
				name: OPENAI_CODEX_GPT_54_MODEL_ID
			} : void 0, sparkTemplate ? {
				...sparkTemplate,
				id: OPENAI_CODEX_GPT_53_SPARK_MODEL_ID,
				name: OPENAI_CODEX_GPT_53_SPARK_MODEL_ID
			} : void 0].filter((entry) => entry !== void 0);
		}
	};
}
//#endregion
//#region src/commands/openai-model-default.ts
const OPENAI_DEFAULT_MODEL = "openai/gpt-5.1-codex";
function applyOpenAIProviderConfig(cfg) {
	const next = ensureModelAllowlistEntry({
		cfg,
		modelRef: OPENAI_DEFAULT_MODEL
	});
	const models = { ...next.agents?.defaults?.models };
	models[OPENAI_DEFAULT_MODEL] = {
		...models[OPENAI_DEFAULT_MODEL],
		alias: models["openai/gpt-5.1-codex"]?.alias ?? "GPT"
	};
	return {
		...next,
		agents: {
			...next.agents,
			defaults: {
				...next.agents?.defaults,
				models
			}
		}
	};
}
function applyOpenAIConfig(cfg) {
	const next = applyOpenAIProviderConfig(cfg);
	return {
		...next,
		agents: {
			...next.agents,
			defaults: {
				...next.agents?.defaults,
				model: next.agents?.defaults?.model && typeof next.agents.defaults.model === "object" ? {
					...next.agents.defaults.model,
					primary: OPENAI_DEFAULT_MODEL
				} : { primary: OPENAI_DEFAULT_MODEL }
			}
		}
	};
}
//#endregion
//#region extensions/openai/openai-provider.ts
const PROVIDER_ID = "openai";
const OPENAI_GPT_54_MODEL_ID = "gpt-5.4";
const OPENAI_GPT_54_PRO_MODEL_ID = "gpt-5.4-pro";
const OPENAI_GPT_54_CONTEXT_TOKENS = 105e4;
const OPENAI_GPT_54_MAX_TOKENS = 128e3;
const OPENAI_GPT_54_TEMPLATE_MODEL_IDS = ["gpt-5.2"];
const OPENAI_GPT_54_PRO_TEMPLATE_MODEL_IDS = ["gpt-5.2-pro", "gpt-5.2"];
const OPENAI_XHIGH_MODEL_IDS = [
	"gpt-5.4",
	"gpt-5.4-pro",
	"gpt-5.2"
];
const OPENAI_MODERN_MODEL_IDS = [
	"gpt-5.4",
	"gpt-5.4-pro",
	"gpt-5.2",
	"gpt-5.0"
];
const OPENAI_DIRECT_SPARK_MODEL_ID = "gpt-5.3-codex-spark";
const SUPPRESSED_SPARK_PROVIDERS = new Set(["openai", "azure-openai-responses"]);
function normalizeOpenAITransport(model) {
	if (!(model.api === "openai-completions" && (!model.baseUrl || isOpenAIApiBaseUrl(model.baseUrl)))) return model;
	return {
		...model,
		api: "openai-responses"
	};
}
function resolveOpenAIGpt54ForwardCompatModel(ctx) {
	const trimmedModelId = ctx.modelId.trim();
	const lower = trimmedModelId.toLowerCase();
	let templateIds;
	if (lower === OPENAI_GPT_54_MODEL_ID) templateIds = OPENAI_GPT_54_TEMPLATE_MODEL_IDS;
	else if (lower === OPENAI_GPT_54_PRO_MODEL_ID) templateIds = OPENAI_GPT_54_PRO_TEMPLATE_MODEL_IDS;
	else return;
	return cloneFirstTemplateModel({
		providerId: PROVIDER_ID,
		modelId: trimmedModelId,
		templateIds,
		ctx,
		patch: {
			api: "openai-responses",
			provider: PROVIDER_ID,
			baseUrl: "https://api.openai.com/v1",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: OPENAI_GPT_54_CONTEXT_TOKENS,
			maxTokens: OPENAI_GPT_54_MAX_TOKENS
		}
	}) ?? normalizeModelCompat({
		id: trimmedModelId,
		name: trimmedModelId,
		api: "openai-responses",
		provider: PROVIDER_ID,
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0
		},
		contextWindow: OPENAI_GPT_54_CONTEXT_TOKENS,
		maxTokens: OPENAI_GPT_54_MAX_TOKENS
	});
}
function buildOpenAIProvider() {
	return {
		id: PROVIDER_ID,
		label: "OpenAI",
		docsPath: "/providers/models",
		envVars: ["OPENAI_API_KEY"],
		auth: [createProviderApiKeyAuthMethod({
			providerId: PROVIDER_ID,
			methodId: "api-key",
			label: "OpenAI API key",
			hint: "Direct OpenAI API key",
			optionKey: "openaiApiKey",
			flagName: "--openai-api-key",
			envVar: "OPENAI_API_KEY",
			promptMessage: "Enter OpenAI API key",
			defaultModel: OPENAI_DEFAULT_MODEL,
			expectedProviders: ["openai"],
			applyConfig: (cfg) => applyOpenAIConfig(cfg),
			wizard: {
				choiceId: "openai-api-key",
				choiceLabel: "OpenAI API key",
				groupId: "openai",
				groupLabel: "OpenAI",
				groupHint: "Codex OAuth + API key"
			}
		})],
		resolveDynamicModel: (ctx) => resolveOpenAIGpt54ForwardCompatModel(ctx),
		normalizeResolvedModel: (ctx) => {
			if (normalizeProviderId(ctx.provider) !== PROVIDER_ID) return;
			return normalizeOpenAITransport(ctx.model);
		},
		capabilities: { providerFamily: "openai" },
		supportsXHighThinking: ({ modelId }) => matchesExactOrPrefix(modelId, OPENAI_XHIGH_MODEL_IDS),
		isModernModelRef: ({ modelId }) => matchesExactOrPrefix(modelId, OPENAI_MODERN_MODEL_IDS),
		buildMissingAuthMessage: (ctx) => {
			if (ctx.provider !== PROVIDER_ID || ctx.listProfileIds("openai-codex").length === 0) return;
			return "No API key found for provider \"openai\". You are authenticated with OpenAI Codex OAuth. Use openai-codex/gpt-5.4 (OAuth) or set OPENAI_API_KEY to use openai/gpt-5.4.";
		},
		suppressBuiltInModel: (ctx) => {
			if (!SUPPRESSED_SPARK_PROVIDERS.has(normalizeProviderId(ctx.provider)) || ctx.modelId.toLowerCase() !== OPENAI_DIRECT_SPARK_MODEL_ID) return;
			return {
				suppress: true,
				errorMessage: `Unknown model: ${ctx.provider}/${OPENAI_DIRECT_SPARK_MODEL_ID}. ${OPENAI_DIRECT_SPARK_MODEL_ID} is only supported via openai-codex OAuth. Use openai-codex/${OPENAI_DIRECT_SPARK_MODEL_ID}.`
			};
		},
		augmentModelCatalog: (ctx) => {
			const openAiGpt54Template = findCatalogTemplate({
				entries: ctx.entries,
				providerId: PROVIDER_ID,
				templateIds: OPENAI_GPT_54_TEMPLATE_MODEL_IDS
			});
			const openAiGpt54ProTemplate = findCatalogTemplate({
				entries: ctx.entries,
				providerId: PROVIDER_ID,
				templateIds: OPENAI_GPT_54_PRO_TEMPLATE_MODEL_IDS
			});
			return [openAiGpt54Template ? {
				...openAiGpt54Template,
				id: OPENAI_GPT_54_MODEL_ID,
				name: OPENAI_GPT_54_MODEL_ID
			} : void 0, openAiGpt54ProTemplate ? {
				...openAiGpt54ProTemplate,
				id: OPENAI_GPT_54_PRO_MODEL_ID,
				name: OPENAI_GPT_54_PRO_MODEL_ID
			} : void 0].filter((entry) => entry !== void 0);
		}
	};
}
//#endregion
//#region extensions/openai/index.ts
const openAIPlugin = {
	id: "openai",
	name: "OpenAI Provider",
	description: "Bundled OpenAI provider plugins",
	configSchema: emptyPluginConfigSchema(),
	register(api) {
		api.registerProvider(buildOpenAIProvider());
		api.registerProvider(buildOpenAICodexProviderPlugin());
	}
};
//#endregion
export { openAIPlugin as default };
