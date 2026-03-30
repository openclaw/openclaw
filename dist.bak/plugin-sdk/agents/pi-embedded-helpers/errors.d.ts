import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../../config/config.js";
import type { FailoverReason } from "./types.js";
export declare function formatBillingErrorMessage(provider?: string, model?: string): string;
export declare const BILLING_ERROR_USER_MESSAGE: string;
export declare function isContextOverflowError(errorMessage?: string): boolean;
export declare function isLikelyContextOverflowError(errorMessage?: string): boolean;
export declare function isCompactionFailureError(errorMessage?: string): boolean;
export declare function isCloudflareOrHtmlErrorPage(raw: string): boolean;
export declare function isTransientHttpError(raw: string): boolean;
export declare function getApiErrorPayloadFingerprint(raw?: string): string | null;
export declare function isRawApiErrorPayload(raw?: string): boolean;
export type ApiErrorInfo = {
    httpCode?: string;
    type?: string;
    message?: string;
    requestId?: string;
};
export declare function parseApiErrorInfo(raw?: string): ApiErrorInfo | null;
export declare function formatRawAssistantErrorForUi(raw?: string): string;
export declare function formatAssistantErrorText(msg: AssistantMessage, opts?: {
    cfg?: OpenClawConfig;
    sessionKey?: string;
    provider?: string;
    model?: string;
}): string | undefined;
export declare function sanitizeUserFacingText(text: string, opts?: {
    errorContext?: boolean;
}): string;
export declare function isRateLimitAssistantError(msg: AssistantMessage | undefined): boolean;
export declare function isRateLimitErrorMessage(raw: string): boolean;
export declare function isTimeoutErrorMessage(raw: string): boolean;
export declare function isBillingErrorMessage(raw: string): boolean;
export declare function isMissingToolCallInputError(raw: string): boolean;
export declare function isBillingAssistantError(msg: AssistantMessage | undefined): boolean;
export declare function isAuthPermanentErrorMessage(raw: string): boolean;
export declare function isAuthErrorMessage(raw: string): boolean;
export declare function isOverloadedErrorMessage(raw: string): boolean;
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
export declare function isModelNotFoundErrorMessage(raw: string): boolean;
export declare function classifyFailoverReason(raw: string): FailoverReason | null;
export declare function isFailoverErrorMessage(raw: string): boolean;
export declare function isFailoverAssistantError(msg: AssistantMessage | undefined): boolean;
