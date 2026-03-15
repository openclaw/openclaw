import "../../provider-env-vars-BfZUtZAn.js";
import { t as emptyPluginConfigSchema } from "../../config-schema-DpOJkOlS.js";
import "../../resolve-route-BZ4hHpx2.js";
import "../../logger-CRwcgB9y.js";
import "../../tmp-openclaw-dir-Bz3ouN_i.js";
import { f as resolveRequiredHomeDir } from "../../paths-Byjx7_T6.js";
import "../../subsystem-CsP80x3t.js";
import "../../utils-o1tyfnZ_.js";
import { n as fetchWithTimeout } from "../../fetch-timeout-csbOmT9G.js";
import "../../fetch-Dx857jUp.js";
import "../../retry-BY_ggjbn.js";
import "../../agent-scope-DV_aCIyi.js";
import "../../exec-BLi45_38.js";
import "../../logger-Bsnck4bK.js";
import "../../core-qWFcsWSH.js";
import "../../paths-OqPpu-UR.js";
import { Kl as normalizeApiKeyInput, Or as normalizeModelCompat, Vl as ensureApiKeyFromOptionEnvOrPrompt, jn as createZaiToolStreamWrapper, kf as DEFAULT_CONTEXT_TOKENS, ql as validateApiKeyInput } from "../../auth-profiles-CuJtivJK.js";
import { i as upsertAuthProfile } from "../../profiles-CV7WLKIX.js";
import "../../fetch-D2ZOzaXt.js";
import "../../external-content-vZzOHxnd.js";
import { t as normalizeOptionalSecretInput } from "../../normalize-secret-input-CZ08wtw1.js";
import "../../kilocode-shared-Ci8SRxXc.js";
import "../../models-config.providers.static-DRBnLpDj.js";
import "../../models-config.providers.discovery-l-LpSxGW.js";
import "../../pairing-token-DKpN4qO0.js";
import "../../query-expansion-txqQdNIf.js";
import "../../redact-BefI-5cC.js";
import "../../mime-33LCeGh-.js";
import "../../typebox-BmZP6XXv.js";
import "../../web-search-plugin-factory-DStYVW2B.js";
import { E as buildApiKeyCredential, T as ZAI_DEFAULT_MODEL_REF, _ as applyZaiProviderConfig, g as applyZaiConfig } from "../../onboard-auth.config-core-RGiehkaJ.js";
import { C as ZAI_GLOBAL_BASE_URL, b as ZAI_CODING_CN_BASE_URL, x as ZAI_CODING_GLOBAL_BASE_URL, y as ZAI_CN_BASE_URL } from "../../onboard-auth.models-DgQQVW6a.js";
import { t as applyAuthProfileConfig } from "../../auth-profile-config-Dyrd8Od7.js";
import "../../onboard-auth.config-minimax-CHFiQ6wX.js";
import "../../onboard-auth.config-opencode-BJ8anUQU.js";
import "../../onboard-auth-DCHJrlNU.js";
import "../../provider-usage.fetch.shared-4in1kuRh.js";
import { t as fetchZaiUsage } from "../../provider-usage.fetch-CT9bwlMB.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
//#region src/commands/zai-endpoint-detect.ts
async function probeZaiChatCompletions(params) {
	try {
		const res = await fetchWithTimeout(`${params.baseUrl}/chat/completions`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${params.apiKey}`,
				"content-type": "application/json"
			},
			body: JSON.stringify({
				model: params.modelId,
				stream: false,
				max_tokens: 1,
				messages: [{
					role: "user",
					content: "ping"
				}]
			})
		}, params.timeoutMs, params.fetchFn);
		if (res.ok) return { ok: true };
		let errorCode;
		let errorMessage;
		try {
			const json = await res.json();
			const code = json?.error?.code;
			const msg = json?.error?.message ?? json?.msg ?? json?.message;
			if (typeof code === "string") errorCode = code;
			else if (typeof code === "number") errorCode = String(code);
			if (typeof msg === "string") errorMessage = msg;
		} catch {}
		return {
			ok: false,
			status: res.status,
			errorCode,
			errorMessage
		};
	} catch {
		return { ok: false };
	}
}
async function detectZaiEndpoint$1(params) {
	if (process.env.VITEST && !params.fetchFn) return null;
	const timeoutMs = params.timeoutMs ?? 5e3;
	const probeCandidates = (() => {
		const general = [{
			endpoint: "global",
			baseUrl: ZAI_GLOBAL_BASE_URL,
			modelId: "glm-5",
			note: "Verified GLM-5 on global endpoint."
		}, {
			endpoint: "cn",
			baseUrl: ZAI_CN_BASE_URL,
			modelId: "glm-5",
			note: "Verified GLM-5 on cn endpoint."
		}];
		const codingGlm5 = [{
			endpoint: "coding-global",
			baseUrl: ZAI_CODING_GLOBAL_BASE_URL,
			modelId: "glm-5",
			note: "Verified GLM-5 on coding-global endpoint."
		}, {
			endpoint: "coding-cn",
			baseUrl: ZAI_CODING_CN_BASE_URL,
			modelId: "glm-5",
			note: "Verified GLM-5 on coding-cn endpoint."
		}];
		const codingFallback = [{
			endpoint: "coding-global",
			baseUrl: ZAI_CODING_GLOBAL_BASE_URL,
			modelId: "glm-4.7",
			note: "Coding Plan endpoint verified, but this key/plan does not expose GLM-5 there. Defaulting to GLM-4.7."
		}, {
			endpoint: "coding-cn",
			baseUrl: ZAI_CODING_CN_BASE_URL,
			modelId: "glm-4.7",
			note: "Coding Plan CN endpoint verified, but this key/plan does not expose GLM-5 there. Defaulting to GLM-4.7."
		}];
		switch (params.endpoint) {
			case "global": return general.filter((candidate) => candidate.endpoint === "global");
			case "cn": return general.filter((candidate) => candidate.endpoint === "cn");
			case "coding-global": return [...codingGlm5.filter((candidate) => candidate.endpoint === "coding-global"), ...codingFallback.filter((candidate) => candidate.endpoint === "coding-global")];
			case "coding-cn": return [...codingGlm5.filter((candidate) => candidate.endpoint === "coding-cn"), ...codingFallback.filter((candidate) => candidate.endpoint === "coding-cn")];
			default: return [
				...general,
				...codingGlm5,
				...codingFallback
			];
		}
	})();
	for (const candidate of probeCandidates) if ((await probeZaiChatCompletions({
		baseUrl: candidate.baseUrl,
		apiKey: params.apiKey,
		modelId: candidate.modelId,
		timeoutMs,
		fetchFn: params.fetchFn
	})).ok) return candidate;
	return null;
}
//#endregion
//#region extensions/zai/detect.ts
let detectZaiEndpointImpl = detectZaiEndpoint$1;
async function detectZaiEndpoint(...args) {
	return await detectZaiEndpointImpl(...args);
}
//#endregion
//#region extensions/zai/index.ts
const PROVIDER_ID = "zai";
const GLM5_MODEL_ID = "glm-5";
const GLM5_TEMPLATE_MODEL_ID = "glm-4.7";
const PROFILE_ID = "zai:default";
function resolveGlm5ForwardCompatModel(ctx) {
	const trimmedModelId = ctx.modelId.trim();
	const lower = trimmedModelId.toLowerCase();
	if (lower !== GLM5_MODEL_ID && !lower.startsWith(`${GLM5_MODEL_ID}-`)) return;
	const template = ctx.modelRegistry.find(PROVIDER_ID, GLM5_TEMPLATE_MODEL_ID);
	if (template) return normalizeModelCompat({
		...template,
		id: trimmedModelId,
		name: trimmedModelId,
		reasoning: true
	});
	return normalizeModelCompat({
		id: trimmedModelId,
		name: trimmedModelId,
		api: "openai-completions",
		provider: PROVIDER_ID,
		reasoning: true,
		input: ["text"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0
		},
		contextWindow: DEFAULT_CONTEXT_TOKENS,
		maxTokens: DEFAULT_CONTEXT_TOKENS
	});
}
function resolveLegacyZaiUsageToken(env) {
	try {
		const authPath = path.join(resolveRequiredHomeDir(env, os.homedir), ".pi", "agent", "auth.json");
		if (!fs.existsSync(authPath)) return;
		const parsed = JSON.parse(fs.readFileSync(authPath, "utf8"));
		return parsed["z-ai"]?.access || parsed.zai?.access;
	} catch {
		return;
	}
}
function resolveZaiDefaultModel(modelIdOverride) {
	return modelIdOverride ? `zai/${modelIdOverride}` : ZAI_DEFAULT_MODEL_REF;
}
async function promptForZaiEndpoint(ctx) {
	return await ctx.prompter.select({
		message: "Select Z.AI endpoint",
		initialValue: "global",
		options: [
			{
				value: "global",
				label: "Global",
				hint: "Z.AI Global (api.z.ai)"
			},
			{
				value: "cn",
				label: "CN",
				hint: "Z.AI CN (open.bigmodel.cn)"
			},
			{
				value: "coding-global",
				label: "Coding-Plan-Global",
				hint: "GLM Coding Plan Global (api.z.ai)"
			},
			{
				value: "coding-cn",
				label: "Coding-Plan-CN",
				hint: "GLM Coding Plan CN (open.bigmodel.cn)"
			}
		]
	});
}
async function runZaiApiKeyAuth(ctx, endpoint) {
	let capturedSecretInput;
	let capturedCredential = false;
	let capturedMode;
	const apiKey = await ensureApiKeyFromOptionEnvOrPrompt({
		token: normalizeOptionalSecretInput(ctx.opts?.zaiApiKey) ?? normalizeOptionalSecretInput(ctx.opts?.token),
		tokenProvider: normalizeOptionalSecretInput(ctx.opts?.zaiApiKey) ? PROVIDER_ID : normalizeOptionalSecretInput(ctx.opts?.tokenProvider),
		secretInputMode: ctx.allowSecretRefPrompt === false ? ctx.secretInputMode ?? "plaintext" : ctx.secretInputMode,
		config: ctx.config,
		expectedProviders: [PROVIDER_ID, "z-ai"],
		provider: PROVIDER_ID,
		envLabel: "ZAI_API_KEY",
		promptMessage: "Enter Z.AI API key",
		normalize: normalizeApiKeyInput,
		validate: validateApiKeyInput,
		prompter: ctx.prompter,
		setCredential: async (key, mode) => {
			capturedSecretInput = key;
			capturedCredential = true;
			capturedMode = mode;
		}
	});
	if (!capturedCredential) throw new Error("Missing Z.AI API key.");
	const credentialInput = capturedSecretInput ?? "";
	const detected = await detectZaiEndpoint({
		apiKey,
		...endpoint ? { endpoint } : {}
	});
	const modelIdOverride = detected?.modelId;
	const nextEndpoint = detected?.endpoint ?? endpoint ?? await promptForZaiEndpoint(ctx);
	return {
		profiles: [{
			profileId: PROFILE_ID,
			credential: buildApiKeyCredential(PROVIDER_ID, credentialInput, void 0, capturedMode ? { secretInputMode: capturedMode } : void 0)
		}],
		configPatch: applyZaiProviderConfig(ctx.config, {
			...nextEndpoint ? { endpoint: nextEndpoint } : {},
			...modelIdOverride ? { modelId: modelIdOverride } : {}
		}),
		defaultModel: resolveZaiDefaultModel(modelIdOverride),
		...detected?.note ? { notes: [detected.note] } : {}
	};
}
async function runZaiApiKeyAuthNonInteractive(ctx, endpoint) {
	const resolved = await ctx.resolveApiKey({
		provider: PROVIDER_ID,
		flagValue: normalizeOptionalSecretInput(ctx.opts.zaiApiKey),
		flagName: "--zai-api-key",
		envVar: "ZAI_API_KEY"
	});
	if (!resolved) return null;
	const detected = await detectZaiEndpoint({
		apiKey: resolved.key,
		...endpoint ? { endpoint } : {}
	});
	const modelIdOverride = detected?.modelId;
	const nextEndpoint = detected?.endpoint ?? endpoint;
	if (resolved.source !== "profile") {
		const credential = ctx.toApiKeyCredential({
			provider: PROVIDER_ID,
			resolved
		});
		if (!credential) return null;
		upsertAuthProfile({
			profileId: PROFILE_ID,
			credential,
			agentDir: ctx.agentDir
		});
	}
	return applyZaiConfig(applyAuthProfileConfig(ctx.config, {
		profileId: PROFILE_ID,
		provider: PROVIDER_ID,
		mode: "api_key"
	}), {
		...nextEndpoint ? { endpoint: nextEndpoint } : {},
		...modelIdOverride ? { modelId: modelIdOverride } : {}
	});
}
function buildZaiApiKeyMethod(params) {
	return {
		id: params.id,
		label: params.choiceLabel,
		hint: params.choiceHint,
		kind: "api_key",
		wizard: {
			choiceId: params.choiceId,
			choiceLabel: params.choiceLabel,
			...params.choiceHint ? { choiceHint: params.choiceHint } : {},
			groupId: "zai",
			groupLabel: "Z.AI",
			groupHint: "GLM Coding Plan / Global / CN"
		},
		run: async (ctx) => await runZaiApiKeyAuth(ctx, params.endpoint),
		runNonInteractive: async (ctx) => await runZaiApiKeyAuthNonInteractive(ctx, params.endpoint)
	};
}
const zaiPlugin = {
	id: PROVIDER_ID,
	name: "Z.AI Provider",
	description: "Bundled Z.AI provider plugin",
	configSchema: emptyPluginConfigSchema(),
	register(api) {
		api.registerProvider({
			id: PROVIDER_ID,
			label: "Z.AI",
			aliases: ["z-ai", "z.ai"],
			docsPath: "/providers/models",
			envVars: ["ZAI_API_KEY", "Z_AI_API_KEY"],
			auth: [
				buildZaiApiKeyMethod({
					id: "api-key",
					choiceId: "zai-api-key",
					choiceLabel: "Z.AI API key"
				}),
				buildZaiApiKeyMethod({
					id: "coding-global",
					choiceId: "zai-coding-global",
					choiceLabel: "Coding-Plan-Global",
					choiceHint: "GLM Coding Plan Global (api.z.ai)",
					endpoint: "coding-global"
				}),
				buildZaiApiKeyMethod({
					id: "coding-cn",
					choiceId: "zai-coding-cn",
					choiceLabel: "Coding-Plan-CN",
					choiceHint: "GLM Coding Plan CN (open.bigmodel.cn)",
					endpoint: "coding-cn"
				}),
				buildZaiApiKeyMethod({
					id: "global",
					choiceId: "zai-global",
					choiceLabel: "Global",
					choiceHint: "Z.AI Global (api.z.ai)",
					endpoint: "global"
				}),
				buildZaiApiKeyMethod({
					id: "cn",
					choiceId: "zai-cn",
					choiceLabel: "CN",
					choiceHint: "Z.AI CN (open.bigmodel.cn)",
					endpoint: "cn"
				})
			],
			resolveDynamicModel: (ctx) => resolveGlm5ForwardCompatModel(ctx),
			prepareExtraParams: (ctx) => {
				if (ctx.extraParams?.tool_stream !== void 0) return ctx.extraParams;
				return {
					...ctx.extraParams,
					tool_stream: true
				};
			},
			wrapStreamFn: (ctx) => createZaiToolStreamWrapper(ctx.streamFn, ctx.extraParams?.tool_stream !== false),
			isBinaryThinking: () => true,
			isModernModelRef: ({ modelId }) => {
				const lower = modelId.trim().toLowerCase();
				return lower.startsWith("glm-5") || lower.startsWith("glm-4.7") || lower.startsWith("glm-4.7-flash") || lower.startsWith("glm-4.7-flashx");
			},
			resolveUsageAuth: async (ctx) => {
				const apiKey = ctx.resolveApiKeyFromConfigAndStore({
					providerIds: [PROVIDER_ID, "z-ai"],
					envDirect: [ctx.env.ZAI_API_KEY, ctx.env.Z_AI_API_KEY]
				});
				if (apiKey) return { token: apiKey };
				const legacyToken = resolveLegacyZaiUsageToken(ctx.env);
				return legacyToken ? { token: legacyToken } : null;
			},
			fetchUsageSnapshot: async (ctx) => await fetchZaiUsage(ctx.token, ctx.timeoutMs, ctx.fetchFn),
			isCacheTtlEligible: () => true
		});
	}
};
//#endregion
export { zaiPlugin as default };
