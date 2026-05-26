import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { y as truncateUtf16Safe } from "./utils-CKsuXgDI.js";
import { s as hasOutboundReplyContent } from "./reply-payload-BOrd8HRU.js";
import { u as stripHeartbeatToken } from "./heartbeat-DJ4ZZ8Yg.js";
//#region src/cron/heartbeat-policy.ts
function shouldSkipHeartbeatOnlyDelivery(payloads, ackMaxChars) {
	if (payloads.length === 0) return true;
	if (payloads.some((payload) => hasOutboundReplyContent({
		...payload,
		text: void 0
	}, { trimText: true }))) return false;
	return payloads.some((payload) => {
		return stripHeartbeatToken(payload.text, {
			mode: "heartbeat",
			maxAckChars: ackMaxChars
		}).shouldSkip;
	});
}
//#endregion
//#region src/cron/isolated-agent/helpers.ts
const CRON_DENIAL_EXACT_TOKENS = ["SYSTEM_RUN_DENIED", "INVALID_REQUEST"];
const CRON_DENIAL_CASE_INSENSITIVE_TOKENS = [
	"approval cannot safely bind",
	"runtime denied",
	"could not run",
	"did not run",
	"was denied"
];
function detectCronDenialToken(text) {
	const normalized = normalizeOptionalString(text);
	if (!normalized) return;
	for (const token of CRON_DENIAL_EXACT_TOKENS) if (normalized.includes(token)) return token;
	const lowerText = normalized.toLowerCase();
	for (const token of CRON_DENIAL_CASE_INSENSITIVE_TOKENS) if (lowerText.includes(token)) return token;
}
function resolveCronDenialSignal(fields) {
	const seen = /* @__PURE__ */ new Set();
	for (const { field, text } of fields) {
		if (seen.has(field)) continue;
		seen.add(field);
		const token = detectCronDenialToken(text);
		if (token) return {
			token,
			field
		};
	}
}
function formatCronDenialSignal(signal) {
	return `cron classifier: denial token "${signal.token}" detected in ${signal.field}`;
}
function normalizeCronFailureSignal(signal) {
	const message = normalizeOptionalString(signal?.message);
	if (signal?.fatalForCron !== true || !message) return;
	return {
		...signal,
		message,
		fatalForCron: true
	};
}
function formatCronFailureSignal(signal) {
	const kind = normalizeOptionalString(signal.kind) ?? "run";
	const code = normalizeOptionalString(signal.code);
	const source = normalizeOptionalString(signal.toolName) ?? normalizeOptionalString(signal.source);
	return `cron classifier: ${kind} failure${source ? ` from ${source}` : ""}${code ? ` (${code})` : ""}: ${signal.message}`;
}
function formatCronRunLevelError(error) {
	const direct = normalizeOptionalString(error);
	if (direct) return `cron isolated run failed: ${direct}`;
	if (!error || typeof error !== "object") return;
	const record = error;
	const message = normalizeOptionalString(record.message);
	if (message) return `cron isolated run failed: ${message}`;
	const kind = normalizeOptionalString(record.kind);
	if (kind) return `cron isolated run failed: ${kind}`;
	return "cron isolated run failed";
}
function pickSummaryFromOutput(text) {
	const clean = (text ?? "").trim();
	if (!clean) return;
	const limit = 2e3;
	return clean.length > limit ? `${truncateUtf16Safe(clean, limit)}…` : clean;
}
function pickSummaryFromPayloads(payloads) {
	for (let i = payloads.length - 1; i >= 0; i--) {
		if (payloads[i]?.isError) continue;
		const summary = pickSummaryFromOutput(payloads[i]?.text);
		if (summary) return summary;
	}
	for (let i = payloads.length - 1; i >= 0; i--) {
		const summary = pickSummaryFromOutput(payloads[i]?.text);
		if (summary) return summary;
	}
}
function pickLastNonEmptyTextFromPayloads(payloads) {
	for (let i = payloads.length - 1; i >= 0; i--) {
		if (payloads[i]?.isError) continue;
		const clean = (payloads[i]?.text ?? "").trim();
		if (clean) return clean;
	}
	for (let i = payloads.length - 1; i >= 0; i--) {
		const clean = (payloads[i]?.text ?? "").trim();
		if (clean) return clean;
	}
}
function isDeliverablePayload(payload) {
	if (!payload) return false;
	return hasOutboundReplyContent(payload, { trimText: true });
}
function payloadHasStructuredDeliveryContent(payload) {
	if (!payload) return false;
	return payload.mediaUrl !== void 0 || (payload.mediaUrls?.length ?? 0) > 0 || (payload.presentation?.blocks?.length ?? 0) > 0 || (payload.interactive?.blocks?.length ?? 0) > 0 || Object.keys(payload.channelData ?? {}).length > 0;
}
function pickLastDeliverablePayload(payloads) {
	for (let i = payloads.length - 1; i >= 0; i--) {
		if (payloads[i]?.isError) continue;
		if (isDeliverablePayload(payloads[i])) return payloads[i];
	}
	for (let i = payloads.length - 1; i >= 0; i--) if (isDeliverablePayload(payloads[i])) return payloads[i];
}
function pickDeliverablePayloads(payloads) {
	const successfulDeliverablePayloads = payloads.filter((payload) => payload != null && payload.isError !== true && isDeliverablePayload(payload));
	if (successfulDeliverablePayloads.length > 0) return successfulDeliverablePayloads;
	const lastDeliverablePayload = pickLastDeliverablePayload(payloads);
	return lastDeliverablePayload ? [lastDeliverablePayload] : [];
}
/**
* Check if delivery should be skipped because the agent signaled no user-visible update.
* Returns true when any payload is a heartbeat ack token and no payload contains media.
*/
function isHeartbeatOnlyResponse(payloads, ackMaxChars) {
	return shouldSkipHeartbeatOnlyDelivery(payloads, ackMaxChars);
}
function resolveHeartbeatAckMaxChars(agentCfg) {
	const raw = agentCfg?.heartbeat?.ackMaxChars ?? 300;
	return Math.max(0, raw);
}
function isCronMessagePresentationWarning(text) {
	const normalized = normalizeOptionalString(text)?.toLowerCase();
	return normalized === "⚠️ ✉️ message failed" || normalized?.startsWith("⚠️ ✉️ message failed:") === true;
}
function resolveCronPayloadOutcome(params) {
	const firstText = params.payloads[0]?.text ?? "";
	const fallbackSummary = pickSummaryFromPayloads(params.payloads) ?? pickSummaryFromOutput(firstText);
	const fallbackOutputText = pickLastNonEmptyTextFromPayloads(params.payloads);
	const deliveryPayload = pickLastDeliverablePayload(params.payloads);
	const selectedDeliveryPayloads = pickDeliverablePayloads(params.payloads);
	const deliveryPayloadHasStructuredContent = payloadHasStructuredDeliveryContent(deliveryPayload);
	const hasErrorPayload = params.payloads.some((payload) => payload?.isError === true);
	const lastErrorPayloadIndex = params.payloads.findLastIndex((payload) => payload?.isError === true);
	const lastErrorPayloadText = [...params.payloads].toReversed().find((payload) => payload?.isError === true && Boolean(payload?.text?.trim()))?.text?.trim();
	const normalizedFinalAssistantVisibleText = normalizeOptionalString(params.finalAssistantVisibleText);
	const hasSuccessfulPayloadAfterLastError = !params.runLevelError && lastErrorPayloadIndex >= 0 && params.payloads.slice(lastErrorPayloadIndex + 1).some((payload) => payload?.isError !== true && Boolean(payload?.text?.trim()));
	const hasSuccessfulPayloadBeforeLastError = !params.runLevelError && lastErrorPayloadIndex > 0 && params.payloads.slice(0, lastErrorPayloadIndex).some((payload) => payload?.isError !== true && Boolean(payload?.text?.trim()));
	const hasPendingPresentationWarning = !params.runLevelError && params.failureSignal?.fatalForCron !== true && lastErrorPayloadIndex >= 0 && isCronMessagePresentationWarning(lastErrorPayloadText) && (normalizedFinalAssistantVisibleText !== void 0 || hasSuccessfulPayloadBeforeLastError);
	const hasFatalStructuredErrorPayload = hasErrorPayload && !hasSuccessfulPayloadAfterLastError && !hasPendingPresentationWarning;
	const hasStructuredDeliveryPayloads = selectedDeliveryPayloads.some((payload) => payloadHasStructuredDeliveryContent(payload));
	const shouldUseFinalAssistantVisibleText = params.preferFinalAssistantVisibleText === true && normalizedFinalAssistantVisibleText !== void 0 && !hasFatalStructuredErrorPayload && !hasStructuredDeliveryPayloads;
	const summary = shouldUseFinalAssistantVisibleText ? pickSummaryFromOutput(normalizedFinalAssistantVisibleText) ?? fallbackSummary : fallbackSummary;
	const outputText = shouldUseFinalAssistantVisibleText ? normalizedFinalAssistantVisibleText : fallbackOutputText;
	const synthesizedText = normalizeOptionalString(outputText) ?? normalizeOptionalString(summary);
	const resolvedDeliveryPayloads = shouldUseFinalAssistantVisibleText ? [{ text: normalizedFinalAssistantVisibleText }] : selectedDeliveryPayloads.length > 0 ? selectedDeliveryPayloads : synthesizedText ? [{ text: synthesizedText }] : [];
	const denialSignal = resolveCronDenialSignal([
		{
			field: "summary",
			text: summary
		},
		{
			field: "outputText",
			text: outputText
		},
		{
			field: "synthesizedText",
			text: synthesizedText
		},
		{
			field: "fallbackSummary",
			text: fallbackSummary
		},
		{
			field: "fallbackOutputText",
			text: fallbackOutputText
		},
		...params.payloads.map((payload, index) => ({
			field: `payloads[${index}].text`,
			text: payload?.text
		}))
	]);
	const failureSignal = normalizeCronFailureSignal(params.failureSignal);
	const runLevelError = formatCronRunLevelError(params.runLevelError);
	const hasFatalErrorPayload = hasFatalStructuredErrorPayload || failureSignal !== void 0 || denialSignal !== void 0 || runLevelError !== void 0;
	const structuredErrorText = hasFatalStructuredErrorPayload ? lastErrorPayloadText ?? "cron isolated run returned an error payload" : void 0;
	const shouldUseRunLevelErrorPayload = runLevelError !== void 0 && structuredErrorText === void 0 && failureSignal === void 0 && denialSignal === void 0;
	const fatalDeliveryText = structuredErrorText ?? failureSignal?.message ?? (shouldUseRunLevelErrorPayload ? runLevelError : void 0);
	const fatalDeliveryPayload = fatalDeliveryText ? {
		text: fatalDeliveryText,
		isError: true
	} : void 0;
	return {
		summary: fatalDeliveryText ? pickSummaryFromOutput(fatalDeliveryText) ?? summary : summary,
		outputText: fatalDeliveryText ?? outputText,
		synthesizedText: fatalDeliveryText ?? synthesizedText,
		deliveryPayload: fatalDeliveryPayload ?? deliveryPayload,
		deliveryPayloads: fatalDeliveryPayload ? [fatalDeliveryPayload] : resolvedDeliveryPayloads,
		deliveryPayloadHasStructuredContent: fatalDeliveryPayload ? false : deliveryPayloadHasStructuredContent,
		hasFatalErrorPayload,
		embeddedRunError: structuredErrorText ? structuredErrorText : failureSignal ? formatCronFailureSignal(failureSignal) : denialSignal ? formatCronDenialSignal(denialSignal) : runLevelError,
		pendingPresentationWarningError: hasPendingPresentationWarning ? lastErrorPayloadText : void 0
	};
}
//#endregion
export { resolveHeartbeatAckMaxChars as a, resolveCronPayloadOutcome as i, pickLastNonEmptyTextFromPayloads as n, pickSummaryFromOutput as r, isHeartbeatOnlyResponse as t };
