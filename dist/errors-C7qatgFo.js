import { a as redactSensitiveText } from "./redact-R2-EdHUS.js";
import "./logging-core-CvQ6nJJA.js";
//#region extensions/slack/src/errors.ts
const NO_ERROR_DETAIL = "no error detail";
function isRecord(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function redact(value) {
	return redactSensitiveText(value);
}
function addStringDetail(details, label, value) {
	if (typeof value !== "string") return;
	const trimmed = redact(value.trim());
	if (trimmed) details.push(label ? `${label}: ${trimmed}` : trimmed);
}
function addScalarDetail(details, label, value) {
	if (typeof value === "string") {
		addStringDetail(details, label, value);
		return;
	}
	if (typeof value === "number" || typeof value === "boolean") details.push(`${label}: ${String(value)}`);
}
function addStringListDetail(details, label, value) {
	if (!Array.isArray(value)) return;
	const entries = value.flatMap((entry) => {
		if (typeof entry !== "string") return [];
		const trimmed = redact(entry.trim());
		return trimmed ? [trimmed] : [];
	});
	if (entries.length) details.push(`${label}: ${entries.join(", ")}`);
}
function safeStringify(value) {
	const seen = /* @__PURE__ */ new WeakSet();
	try {
		const result = JSON.stringify(value, (_key, nested) => {
			if (typeof nested !== "object" || nested === null) return nested;
			if (seen.has(nested)) return "[Circular]";
			seen.add(nested);
			return nested;
		});
		return result ? redact(result) : void 0;
	} catch {
		return;
	}
}
function addSlackResponseMetadata(details, value) {
	if (!isRecord(value)) return;
	addStringListDetail(details, "scopes", value.scopes);
	addStringListDetail(details, "accepted", value.acceptedScopes);
	const messages = value.messages;
	if (Array.isArray(messages)) for (const message of messages) addStringDetail(details, "slack message", message);
	const warnings = value.warnings;
	if (Array.isArray(warnings)) for (const warning of warnings) addStringDetail(details, "slack warning", warning);
}
function addSlackDataDetails(details, value) {
	if (!isRecord(value)) return;
	addScalarDetail(details, "slack error", value.error);
	addScalarDetail(details, "needed", value.needed);
	addScalarDetail(details, "provided", value.provided);
	addSlackResponseMetadata(details, value.response_metadata);
}
function addRecordDetails(details, value) {
	addScalarDetail(details, "code", value.code);
	addScalarDetail(details, "status", value.status);
	addScalarDetail(details, "statusCode", value.statusCode);
	addScalarDetail(details, "statusMessage", value.statusMessage);
	addScalarDetail(details, "retryAfter", value.retryAfter);
	addScalarDetail(details, "errno", value.errno);
	addScalarDetail(details, "syscall", value.syscall);
	addScalarDetail(details, "hostname", value.hostname);
	addScalarDetail(details, "type", value.type);
	addStringDetail(details, "statusText", value.statusText);
	addStringDetail(details, "body", value.body);
	addSlackDataDetails(details, value.data);
	if (isRecord(value.response)) {
		addScalarDetail(details, "response status", value.response.status);
		addStringDetail(details, "response statusText", value.response.statusText);
		addSlackDataDetails(details, value.response.data);
	}
}
function collectSlackErrorDetails(error) {
	const details = [];
	if (error === void 0 || error === null) return details;
	if (typeof error === "string") {
		addStringDetail(details, "", error);
		return details;
	}
	if (error instanceof Error) {
		addStringDetail(details, "", error.message || error.name);
		if (error.cause !== void 0) {
			const cause = formatSlackError(error.cause, "");
			if (cause) details.push(`cause: ${cause}`);
		}
	}
	if (isRecord(error)) {
		addRecordDetails(details, error);
		const fallback = safeStringify(error);
		if (details.length === 0 && fallback && fallback !== "{}") details.push(fallback);
	}
	return details;
}
function formatSlackError(error, fallback = NO_ERROR_DETAIL) {
	const details = collectSlackErrorDetails(error);
	if (details.length > 0) return details.join("; ");
	if (error === void 0 || error === null) return fallback;
	if (typeof error === "string" && !error.trim()) return fallback;
	return safeStringify(error) ?? fallback;
}
//#endregion
export { formatSlackError as t };
