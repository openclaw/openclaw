import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
//#region src/agents/provider-http-errors.ts
function asBoolean(value) {
	return typeof value === "boolean" ? value : void 0;
}
function asObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function truncateErrorDetail(detail, limit = 220) {
	return detail.length <= limit ? detail : `${detail.slice(0, limit - 1)}…`;
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
async function extractProviderErrorDetail(response) {
	const rawBody = normalizeOptionalString(await readResponseTextLimited(response));
	if (!rawBody) return;
	try {
		return formatProviderErrorPayload(JSON.parse(rawBody)) ?? truncateErrorDetail(rawBody);
	} catch {
		return truncateErrorDetail(rawBody);
	}
}
function extractProviderRequestId(response) {
	return normalizeOptionalString(response.headers.get("x-request-id")) ?? normalizeOptionalString(response.headers.get("request-id"));
}
function formatProviderHttpErrorMessage(params) {
	const { label, status, detail, requestId, statusPrefix = "" } = params;
	return `${label} (${statusPrefix}${status})` + (detail ? `: ${detail}` : "") + (requestId ? ` [request_id=${requestId}]` : "");
}
async function createProviderHttpError(response, label, options) {
	const detail = await extractProviderErrorDetail(response);
	const requestId = extractProviderRequestId(response);
	return new Error(formatProviderHttpErrorMessage({
		label,
		status: response.status,
		detail,
		requestId,
		statusPrefix: options?.statusPrefix
	}));
}
async function assertOkOrThrowProviderError(response, label) {
	if (response.ok) return;
	throw await createProviderHttpError(response, label);
}
async function assertOkOrThrowHttpError(response, label) {
	if (response.ok) return;
	throw await createProviderHttpError(response, label, { statusPrefix: "HTTP " });
}
//#endregion
export { createProviderHttpError as a, formatProviderErrorPayload as c, truncateErrorDetail as d, assertOkOrThrowProviderError as i, formatProviderHttpErrorMessage as l, asObject as n, extractProviderErrorDetail as o, assertOkOrThrowHttpError as r, extractProviderRequestId as s, asBoolean as t, readResponseTextLimited as u };
