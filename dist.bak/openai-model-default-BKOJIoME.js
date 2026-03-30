import { n as fetchWithTimeout } from "./fetch-timeout-Wg2M0G8N.js";
import { At as ZAI_CODING_CN_BASE_URL, Mt as ZAI_GLOBAL_BASE_URL, jt as ZAI_CODING_GLOBAL_BASE_URL, kt as ZAI_CN_BASE_URL } from "./auth-token-CIHzk-VH.js";
import { l as ensureModelAllowlistEntry } from "./auth-choice.apply-helpers-CxuBk25X.js";

//#region src/commands/model-default.ts
function resolvePrimaryModel(model) {
	if (typeof model === "string") return model;
	if (model && typeof model === "object" && typeof model.primary === "string") return model.primary;
}
function applyAgentDefaultPrimaryModel(params) {
	const current = resolvePrimaryModel(params.cfg.agents?.defaults?.model)?.trim();
	if ((current && params.legacyModels?.has(current) ? params.model : current) === params.model) return {
		next: params.cfg,
		changed: false
	};
	return {
		next: {
			...params.cfg,
			agents: {
				...params.cfg.agents,
				defaults: {
					...params.cfg.agents?.defaults,
					model: params.cfg.agents?.defaults?.model && typeof params.cfg.agents.defaults.model === "object" ? {
						...params.cfg.agents.defaults.model,
						primary: params.model
					} : { primary: params.model }
				}
			}
		},
		changed: true
	};
}

//#endregion
//#region src/commands/google-gemini-model-default.ts
const GOOGLE_GEMINI_DEFAULT_MODEL = "google/gemini-3-pro-preview";
function applyGoogleGeminiModelDefault(cfg) {
	return applyAgentDefaultPrimaryModel({
		cfg,
		model: GOOGLE_GEMINI_DEFAULT_MODEL
	});
}

//#endregion
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
async function detectZaiEndpoint(params) {
	if (process.env.VITEST && !params.fetchFn) return null;
	const timeoutMs = params.timeoutMs ?? 5e3;
	const glm5 = [{
		endpoint: "global",
		baseUrl: ZAI_GLOBAL_BASE_URL
	}, {
		endpoint: "cn",
		baseUrl: ZAI_CN_BASE_URL
	}];
	for (const candidate of glm5) if ((await probeZaiChatCompletions({
		baseUrl: candidate.baseUrl,
		apiKey: params.apiKey,
		modelId: "glm-5",
		timeoutMs,
		fetchFn: params.fetchFn
	})).ok) return {
		endpoint: candidate.endpoint,
		baseUrl: candidate.baseUrl,
		modelId: "glm-5",
		note: `Verified GLM-5 on ${candidate.endpoint} endpoint.`
	};
	const coding = [{
		endpoint: "coding-global",
		baseUrl: ZAI_CODING_GLOBAL_BASE_URL
	}, {
		endpoint: "coding-cn",
		baseUrl: ZAI_CODING_CN_BASE_URL
	}];
	for (const candidate of coding) if ((await probeZaiChatCompletions({
		baseUrl: candidate.baseUrl,
		apiKey: params.apiKey,
		modelId: "glm-4.7",
		timeoutMs,
		fetchFn: params.fetchFn
	})).ok) return {
		endpoint: candidate.endpoint,
		baseUrl: candidate.baseUrl,
		modelId: "glm-4.7",
		note: "Coding Plan endpoint detected; GLM-5 is not available there. Defaulting to GLM-4.7."
	};
	return null;
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
		alias: models[OPENAI_DEFAULT_MODEL]?.alias ?? "GPT"
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
export { GOOGLE_GEMINI_DEFAULT_MODEL as a, detectZaiEndpoint as i, applyOpenAIConfig as n, applyGoogleGeminiModelDefault as o, applyOpenAIProviderConfig as r, OPENAI_DEFAULT_MODEL as t };