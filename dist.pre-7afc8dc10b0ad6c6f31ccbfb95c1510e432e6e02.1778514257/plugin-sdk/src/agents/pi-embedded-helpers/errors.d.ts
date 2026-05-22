import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
export { extractLeadingHttpStatus, formatRawAssistantErrorForUi, isCloudflareOrHtmlErrorPage, parseApiErrorInfo, } from "../../shared/assistant-error-format.js";
import { isModelNotFoundErrorMessage } from "../live-model-errors.js";
import type { FailoverReason } from "./types.js";
export { BILLING_ERROR_USER_MESSAGE, formatBillingErrorMessage, formatRateLimitOrOverloadedErrorCopy, getApiErrorPayloadFingerprint, isRawApiErrorPayload, sanitizeUserFacingText, } from "./sanitize-user-facing-text.js";
export { isAuthErrorMessage, isAuthPermanentErrorMessage, isBillingErrorMessage, isOverloadedErrorMessage, isRateLimitErrorMessage, isServerErrorMessage, isTimeoutErrorMessage, } from "./failover-matches.js";
export declare function isReasoningConstraintErrorMessage(raw: string): boolean;
export declare function isContextOverflowError(errorMessage?: string): boolean;
export declare function isLikelyContextOverflowError(errorMessage?: string): boolean;
export declare function isCompactionFailureError(errorMessage?: string): boolean;
export declare function extractObservedOverflowTokenCount(errorMessage?: string): number | undefined;
export type FailoverSignal = {
    status?: number;
    code?: string;
    message?: string;
    provider?: string;
};
export type FailoverClassification = {
    kind: "reason";
    reason: FailoverReason;
} | {
    kind: "context_overflow";
};
export type ProviderRuntimeFailureKind = "auth_scope" | "auth_refresh" | "refresh_timeout" | "refresh_contention" | "callback_timeout" | "callback_validation" | "auth_html_403" | "upstream_html" | "proxy" | "rate_limit" | "dns" | "timeout" | "schema" | "sandbox_blocked" | "replay_invalid" | "empty_response" | "no_error_details" | "unclassified" | "unknown";
export declare function inferSignalStatus(signal: FailoverSignal): number | undefined;
export declare function isUnclassifiedNoBodyHttpSignal(signal: FailoverSignal): boolean;
export declare function isTransientHttpError(raw: string): boolean;
export declare function classifyFailoverReasonFromHttpStatus(status: number | undefined, message?: string, opts?: {
    provider?: string;
}): FailoverReason | null;
export declare function classifyFailoverSignal(signal: FailoverSignal): FailoverClassification | null;
export declare function classifyProviderRuntimeFailureKind(signal: FailoverSignal | string): ProviderRuntimeFailureKind;
export declare function formatAssistantErrorText(msg: AssistantMessage, opts?: {
    cfg?: OpenClawConfig;
    sessionKey?: string;
    provider?: string;
    model?: string;
}): string | undefined;
export declare function isRateLimitAssistantError(msg: AssistantMessage | undefined): boolean;
export declare function isMissingToolCallInputError(raw: string): boolean;
export declare function isBillingAssistantError(msg: AssistantMessage | undefined): boolean;
export declare function parseImageDimensionError(raw: string): {
    maxDimensionPx?: number;
    messageIndex?: number;
    contentIndex?: number;
    raw: string;
} | null;
export declare function isImageDimensionErrorMessage(raw: string): boolean;
export declare function parseImageSizeError(raw: string): {
    maxMb?: number;
    raw: string;
} | null;
export declare function isImageSizeError(errorMessage?: string): boolean;
export declare function isCloudCodeAssistFormatError(raw: string): boolean;
export declare function isAuthAssistantError(msg: AssistantMessage | undefined): boolean;
export { isModelNotFoundErrorMessage };
export declare function classifyFailoverReason(raw: string, opts?: {
    provider?: string;
}): FailoverReason | null;
export declare function isFailoverErrorMessage(raw: string, opts?: {
    provider?: string;
}): boolean;
export declare function isFailoverAssistantError(msg: AssistantMessage | undefined): boolean;
