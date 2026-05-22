import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { s as resolveProviderRequestHeaders } from "./provider-request-config-C4XXSCDA.js";
import { n as fetchWithSsrFGuard } from "./fetch-guard-DO86P4h3.js";
import { o as createProviderHttpError } from "./provider-http-errors-ho1SUoaN.js";
import { n as captureWsEvent } from "./runtime-CVlkKyaA.js";
import "./proxy-capture-BW97T-SV.js";
import "./string-coerce-runtime-DVkpEjUr.js";
import "./ssrf-runtime-Cu4zbqxY.js";
import "./provider-http-Dbl2jV7_.js";
//#region extensions/openai/realtime-provider-shared.ts
const trimToUndefined = normalizeOptionalString;
function asFiniteNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function asObjectRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function readRealtimeErrorDetail(error) {
	if (typeof error === "string" && error) return error;
	const message = asObjectRecord(error)?.message;
	if (typeof message === "string" && message) return message;
	return "Unknown error";
}
function resolveOpenAIProviderConfigRecord(config) {
	return asObjectRecord(asObjectRecord(config.providers)?.openai) ?? asObjectRecord(config.openai) ?? asObjectRecord(config);
}
function captureOpenAIRealtimeWsClose(params) {
	captureWsEvent({
		url: params.url,
		direction: "local",
		kind: "ws-close",
		flowId: params.flowId,
		closeCode: typeof params.code === "number" ? params.code : void 0,
		meta: {
			provider: "openai",
			capability: params.capability,
			reason: Buffer.isBuffer(params.reasonBuffer) && params.reasonBuffer.length > 0 ? params.reasonBuffer.toString("utf8") : void 0
		}
	});
}
function readStringField(value, key) {
	if (!value || typeof value !== "object") return;
	const raw = value[key];
	return typeof raw === "string" && raw.trim() ? raw.trim() : void 0;
}
async function createOpenAIRealtimeSecret(params) {
	const { response, release } = await fetchWithSsrFGuard({
		url: params.url,
		init: {
			method: "POST",
			headers: resolveProviderRequestHeaders({
				provider: "openai",
				baseUrl: params.url,
				capability: "audio",
				transport: "http",
				defaultHeaders: {
					Authorization: `Bearer ${params.authToken}`,
					"Content-Type": "application/json"
				}
			}) ?? {
				Authorization: `Bearer ${params.authToken}`,
				"Content-Type": "application/json"
			},
			body: JSON.stringify(params.body)
		},
		auditContext: params.auditContext
	});
	const payload = await (async () => {
		try {
			if (!response.ok) throw await createProviderHttpError(response, params.errorMessage);
			return await response.json();
		} finally {
			await release();
		}
	})();
	const nestedSecret = payload && typeof payload === "object" ? payload.client_secret : void 0;
	const clientSecret = readStringField(payload, "value") ?? readStringField(nestedSecret, "value");
	if (!clientSecret) throw new Error(params.missingValueMessage);
	const expiresAt = payload && typeof payload === "object" ? payload.expires_at : void 0;
	return {
		value: clientSecret,
		...typeof expiresAt === "number" ? { expiresAt } : {}
	};
}
async function createOpenAIRealtimeClientSecret(params) {
	const url = "https://api.openai.com/v1/realtime/client_secrets";
	return createOpenAIRealtimeSecret({
		...params,
		url,
		body: { session: params.session },
		errorMessage: "OpenAI Realtime client secret failed",
		missingValueMessage: "OpenAI Realtime client secret response did not include a value"
	});
}
async function createOpenAIRealtimeTranscriptionClientSecret(params) {
	const url = "https://api.openai.com/v1/realtime/transcription_sessions";
	return createOpenAIRealtimeSecret({
		...params,
		url,
		body: params.session,
		errorMessage: "OpenAI Realtime transcription client secret failed",
		missingValueMessage: "OpenAI Realtime transcription client secret response did not include a value"
	});
}
//#endregion
export { createOpenAIRealtimeTranscriptionClientSecret as a, trimToUndefined as c, createOpenAIRealtimeClientSecret as i, asObjectRecord as n, readRealtimeErrorDetail as o, captureOpenAIRealtimeWsClose as r, resolveOpenAIProviderConfigRecord as s, asFiniteNumber as t };
