import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { y as truncateUtf16Safe } from "./utils-sBTEdeml.js";
import { i as getReplyPayloadMetadata } from "./reply-payload-CiT5mlcY.js";
import { s as hasOutboundReplyContent } from "./reply-payload-DMPQsrQC.js";
import { d as stripHeartbeatToken } from "./heartbeat-6oYmHVVQ.js";
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
		if (isNonTerminalToolErrorWarning(payloads[i])) continue;
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
		if (isNonTerminalToolErrorWarning(payloads[i])) continue;
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
function isCronToolWarning(text) {
	return normalizeOptionalString(text)?.startsWith("⚠️ 🛠️ ") === true;
}
function isNonTerminalToolErrorWarning(payload) {
	return Boolean(payload && getReplyPayloadMetadata(payload)?.nonTerminalToolErrorWarning);
}
function isSuccessfulCronPayload(payload) {
	return payload?.isError !== true && (isDeliverablePayload(payload) || payloadHasStructuredDeliveryContent(payload));
}
function resolveCronPayloadOutcome(params) {
	const firstText = params.payloads.find((payload) => !isNonTerminalToolErrorWarning(payload))?.text ?? "";
	const fallbackSummary = pickSummaryFromPayloads(params.payloads) ?? pickSummaryFromOutput(firstText);
	const fallbackOutputText = pickLastNonEmptyTextFromPayloads(params.payloads);
	const deliveryPayload = pickLastDeliverablePayload(params.payloads);
	const selectedDeliveryPayloads = pickDeliverablePayloads(params.payloads);
	const deliveryPayloadHasStructuredContent = payloadHasStructuredDeliveryContent(deliveryPayload);
	const hasErrorPayload = params.payloads.some((payload) => payload?.isError === true);
	const lastErrorPayloadIndex = params.payloads.findLastIndex((payload) => payload?.isError === true);
	const lastErrorPayloadText = [...params.payloads].toReversed().find((payload) => payload?.isError === true && Boolean(payload?.text?.trim()))?.text?.trim();
	const errorPayloads = params.payloads.filter((payload) => payload?.isError === true);
	const normalizedFinalAssistantVisibleText = normalizeOptionalString(params.finalAssistantVisibleText);
	const hasSuccessfulPayloadAfterLastError = !params.runLevelError && lastErrorPayloadIndex >= 0 && params.payloads.slice(lastErrorPayloadIndex + 1).some(isSuccessfulCronPayload);
	const hasSuccessfulPayloadBeforeLastError = !params.runLevelError && lastErrorPayloadIndex > 0 && params.payloads.slice(0, lastErrorPayloadIndex).some(isSuccessfulCronPayload);
	const lastErrorPayload = lastErrorPayloadIndex >= 0 ? params.payloads[lastErrorPayloadIndex] : void 0;
	const hasRecoveringTerminalOutput = normalizedFinalAssistantVisibleText !== void 0 || hasSuccessfulPayloadAfterLastError || hasSuccessfulPayloadBeforeLastError;
	const hasNonTerminalToolErrorWarning = !params.runLevelError && params.failureSignal?.fatalForCron !== true && hasRecoveringTerminalOutput && isNonTerminalToolErrorWarning(lastErrorPayload);
	const hasPendingPresentationWarning = !params.runLevelError && params.failureSignal?.fatalForCron !== true && lastErrorPayloadIndex >= 0 && isCronMessagePresentationWarning(lastErrorPayloadText) && (normalizedFinalAssistantVisibleText !== void 0 || hasSuccessfulPayloadBeforeLastError);
	const hasStructuredDeliveryPayloads = selectedDeliveryPayloads.some((payload) => payloadHasStructuredDeliveryContent(payload));
	const hasRecoveredToolWarning = !params.runLevelError && params.failureSignal?.fatalForCron !== true && params.preferFinalAssistantVisibleText === true && normalizedFinalAssistantVisibleText !== void 0 && !hasStructuredDeliveryPayloads && errorPayloads.length > 0 && errorPayloads.every((payload) => isCronToolWarning(payload?.text));
	const hasFatalStructuredErrorPayload = hasErrorPayload && !hasSuccessfulPayloadAfterLastError && !hasPendingPresentationWarning && !hasNonTerminalToolErrorWarning && !hasRecoveredToolWarning;
	const shouldUseFinalAssistantVisibleText = params.preferFinalAssistantVisibleText === true && normalizedFinalAssistantVisibleText !== void 0 && !hasFatalStructuredErrorPayload && !hasStructuredDeliveryPayloads;
	const summary = shouldUseFinalAssistantVisibleText ? pickSummaryFromOutput(normalizedFinalAssistantVisibleText) ?? fallbackSummary : fallbackSummary;
	const outputText = shouldUseFinalAssistantVisibleText ? normalizedFinalAssistantVisibleText : fallbackOutputText;
	const synthesizedText = normalizeOptionalString(outputText) ?? normalizeOptionalString(summary);
	const resolvedDeliveryPayloads = shouldUseFinalAssistantVisibleText ? [{ text: normalizedFinalAssistantVisibleText }] : selectedDeliveryPayloads.length > 0 ? selectedDeliveryPayloads : synthesizedText ? [{ text: synthesizedText }] : [];
	const failureSignal = normalizeCronFailureSignal(params.failureSignal);
	const runLevelError = formatCronRunLevelError(params.runLevelError);
	const hasFatalErrorPayload = hasFatalStructuredErrorPayload || failureSignal !== void 0 || runLevelError !== void 0;
	const structuredErrorText = hasFatalStructuredErrorPayload ? lastErrorPayloadText ?? "cron isolated run returned an error payload" : void 0;
	const shouldUseRunLevelErrorPayload = runLevelError !== void 0 && structuredErrorText === void 0 && failureSignal === void 0;
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
		hasFatalStructuredErrorPayload,
		embeddedRunError: structuredErrorText ? structuredErrorText : failureSignal ? formatCronFailureSignal(failureSignal) : runLevelError,
		pendingPresentationWarningError: hasPendingPresentationWarning ? lastErrorPayloadText : void 0
	};
}
//#endregion
export { resolveHeartbeatAckMaxChars as a, resolveCronPayloadOutcome as i, pickLastNonEmptyTextFromPayloads as n, pickSummaryFromOutput as r, isHeartbeatOnlyResponse as t };
