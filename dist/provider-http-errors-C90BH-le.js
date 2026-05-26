import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { s as redactSensitiveText } from "./redact-ok5Q8nmw.js";
//#region src/agents/provider-http-errors.ts
const ERROR_BODY_METADATA_LIMIT = 500;
function asBoolean(value) {
	return typeof value === "boolean" ? value : void 0;
}
function asObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function truncateErrorDetail(detail, limit = 220) {
	return detail.length <= limit ? detail : `${detail.slice(0, limit - 1)}…`;
}
function redactProviderErrorBody(body) {
	return truncateErrorDetail(redactSensitiveText(body), ERROR_BODY_METADATA_LIMIT);
}
async function readResponseTextLimited(response, limitBytes = 16 * 1024) {
	if (limitBytes <= 0) return "";
	const reader = response.body?.getReader();
	if (!reader) return "";
	const decoder = new TextDecoder();
	let total = 0;
	let text = "";
	let reachedLimit = false;
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			if (!value || value.byteLength === 0) continue;
			const remaining = limitBytes - total;
			if (remaining <= 0) {
				reachedLimit = true;
				break;
			}
			const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
			total += chunk.byteLength;
			text += decoder.decode(chunk, { stream: true });
			if (total >= limitBytes) {
				reachedLimit = true;
				break;
			}
		}
		text += decoder.decode();
	} finally {
		if (reachedLimit) await reader.cancel().catch(() => {});
	}
	return text;
}
function formatProviderErrorPayload(payload) {
	const root = asObject(payload);
	const detailObject = asObject(root?.detail);
	const subject = asObject(root?.error) ?? detailObject ?? root;
	if (!subject) return;
	const message = normalizeOptionalString(subject.message) ?? normalizeOptionalString(subject.detail) ?? normalizeOptionalString(root?.message) ?? normalizeOptionalString(root?.error) ?? normalizeOptionalString(root?.detail);
	const type = normalizeOptionalString(subject.type);
	const code = normalizeOptionalString(subject.code) ?? normalizeOptionalString(subject.status);
	const metadata = [type ? `type=${type}` : void 0, code ? `code=${code}` : void 0].filter((value) => Boolean(value)).join(", ");
	if (message && metadata) return `${truncateErrorDetail(message)} [${metadata}]`;
	if (message) return truncateErrorDetail(message);
	if (metadata) return `[${metadata}]`;
}
function extractProviderErrorPayloadMetadata(payload) {
	const root = asObject(payload);
	const detailObject = asObject(root?.detail);
	const subject = asObject(root?.error) ?? detailObject ?? root;
	if (!subject) return {};
	const detail = formatProviderErrorPayload(payload);
	const type = normalizeOptionalString(subject.type);
	const code = normalizeOptionalString(subject.code) ?? normalizeOptionalString(subject.status);
	return {
		...detail ? { detail: redactSensitiveText(detail) } : {},
		...code ? { code } : {},
		...type ? { type } : {}
	};
}
async function extractProviderErrorInfo(response) {
	const rawBody = normalizeOptionalString(await readResponseTextLimited(response));
	const requestId = extractProviderRequestId(response);
	if (!rawBody) return requestId ? { requestId } : {};
	const body = redactProviderErrorBody(rawBody);
	try {
		const metadata = extractProviderErrorPayloadMetadata(JSON.parse(rawBody));
		return {
			...metadata.detail ? { detail: metadata.detail } : { detail: body },
			...metadata.code ? { code: metadata.code } : {},
			...metadata.type ? { type: metadata.type } : {},
			body,
			...requestId ? { requestId } : {}
		};
	} catch {
		return {
			detail: body,
			body,
			...requestId ? { requestId } : {}
		};
	}
}
async function extractProviderErrorDetail(response) {
	return (await extractProviderErrorInfo(response)).detail;
}
function extractProviderRequestId(response) {
	return normalizeOptionalString(response.headers.get("x-request-id")) ?? normalizeOptionalString(response.headers.get("request-id"));
}
var ProviderHttpError = class extends Error {
	constructor(message, params) {
		super(message);
		this.name = "ProviderHttpError";
		this.status = params.status;
		this.statusCode = params.status;
		this.code = params.code;
		this.errorCode = params.code;
		this.errorType = params.type;
		this.errorBody = params.body;
		this.requestId = params.requestId;
	}
};
function formatProviderHttpErrorMessage(params) {
	const { label, status, detail, requestId, statusPrefix = "" } = params;
	return `${label} (${statusPrefix}${status})` + (detail ? `: ${detail}` : "") + (requestId ? ` [request_id=${requestId}]` : "");
}
async function createProviderHttpError(response, label, options) {
	const info = await extractProviderErrorInfo(response);
	return new ProviderHttpError(formatProviderHttpErrorMessage({
		label,
		status: response.status,
		detail: info.detail,
		requestId: info.requestId,
		statusPrefix: options?.statusPrefix
	}), {
		status: response.status,
		code: info.code,
		type: info.type,
		body: info.body,
		requestId: info.requestId
	});
}
async function assertOkOrThrowProviderError(response, label) {
	if (response.ok) return;
	throw await createProviderHttpError(response, label);
}
async function assertOkOrThrowHttpError(response, label) {
	if (response.ok) return;
	throw await createProviderHttpError(response, label, { statusPrefix: "HTTP " });
}
async function readProviderJsonResponse(response, label) {
	try {
		return await response.json();
	} catch (cause) {
		throw new Error(`${label}: malformed JSON response`, { cause });
	}
}
async function readProviderJsonObjectResponse(response, label) {
	const object = asObject(await readProviderJsonResponse(response, label));
	if (!object) throw new Error(`${label}: malformed JSON response`);
	return object;
}
async function readProviderJsonArrayFieldResponse(response, label, field) {
	const value = (await readProviderJsonObjectResponse(response, label))[field];
	if (!Array.isArray(value)) throw new Error(`${label}: malformed JSON response`);
	return value;
}
function normalizeContentType(response) {
	return response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() || void 0;
}
function assertProviderBinaryResponseContent(response, label, kind = "binary") {
	const contentType = normalizeContentType(response);
	if (!contentType) return;
	if (contentType === "application/json" || contentType.endsWith("+json") || contentType.startsWith("text/")) throw new Error(`${label}: malformed ${kind} response`);
}
async function readProviderBinaryResponse(response, label, kind = "binary") {
	assertProviderBinaryResponseContent(response, label, kind);
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.byteLength === 0) throw new Error(`${label}: malformed ${kind} response`);
	return bytes;
}
//#endregion
export { assertProviderBinaryResponseContent as a, extractProviderRequestId as c, readProviderBinaryResponse as d, readProviderJsonArrayFieldResponse as f, truncateErrorDetail as g, readResponseTextLimited as h, assertOkOrThrowProviderError as i, formatProviderErrorPayload as l, readProviderJsonResponse as m, asObject as n, createProviderHttpError as o, readProviderJsonObjectResponse as p, assertOkOrThrowHttpError as r, extractProviderErrorDetail as s, asBoolean as t, formatProviderHttpErrorMessage as u };
