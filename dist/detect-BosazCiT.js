import { a as ZAI_DEFAULT_MODEL_ID, n as ZAI_CODING_CN_BASE_URL, r as ZAI_CODING_GLOBAL_BASE_URL, s as ZAI_GLOBAL_BASE_URL, t as ZAI_CN_BASE_URL } from "./model-definitions-B1PKfuNM.js";
//#region extensions/zai/detect.ts
async function fetchWithTimeoutLocal(fetchFn, url, init, timeoutMs) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetchFn(url, {
			...init,
			signal: controller.signal
		});
	} finally {
		clearTimeout(timeout);
	}
}
async function probeZaiChatCompletions(params) {
	try {
		const res = await fetchWithTimeoutLocal(params.fetchFn ?? globalThis.fetch, `${params.baseUrl}/chat/completions`, {
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
		}, params.timeoutMs);
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
	const probeCandidates = (() => {
		const general = [{
			endpoint: "global",
			baseUrl: ZAI_GLOBAL_BASE_URL,
			modelId: ZAI_DEFAULT_MODEL_ID,
			note: "Verified GLM-5.1 on global endpoint."
		}, {
			endpoint: "cn",
			baseUrl: ZAI_CN_BASE_URL,
			modelId: ZAI_DEFAULT_MODEL_ID,
			note: "Verified GLM-5.1 on cn endpoint."
		}];
		const codingGlm51 = [{
			endpoint: "coding-global",
			baseUrl: ZAI_CODING_GLOBAL_BASE_URL,
			modelId: ZAI_DEFAULT_MODEL_ID,
			note: "Verified GLM-5.1 on coding-global endpoint."
		}, {
			endpoint: "coding-cn",
			baseUrl: ZAI_CODING_CN_BASE_URL,
			modelId: ZAI_DEFAULT_MODEL_ID,
			note: "Verified GLM-5.1 on coding-cn endpoint."
		}];
		const codingFallback = [{
			endpoint: "coding-global",
			baseUrl: ZAI_CODING_GLOBAL_BASE_URL,
			modelId: "glm-4.7",
			note: "Coding Plan endpoint verified, but this key/plan does not expose GLM-5.1 there. Defaulting to GLM-4.7."
		}, {
			endpoint: "coding-cn",
			baseUrl: ZAI_CODING_CN_BASE_URL,
			modelId: "glm-4.7",
			note: "Coding Plan CN endpoint verified, but this key/plan does not expose GLM-5.1 there. Defaulting to GLM-4.7."
		}];
		switch (params.endpoint) {
			case "global": return general.filter((candidate) => candidate.endpoint === "global");
			case "cn": return general.filter((candidate) => candidate.endpoint === "cn");
			case "coding-global": return [...codingGlm51.filter((candidate) => candidate.endpoint === "coding-global"), ...codingFallback.filter((candidate) => candidate.endpoint === "coding-global")];
			case "coding-cn": return [...codingGlm51.filter((candidate) => candidate.endpoint === "coding-cn"), ...codingFallback.filter((candidate) => candidate.endpoint === "coding-cn")];
			default: return [
				...general,
				...codingGlm51,
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
export { detectZaiEndpoint as t };
