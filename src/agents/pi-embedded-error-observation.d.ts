import { type ProviderRuntimeFailureKind } from "./pi-embedded-helpers.js";
export { sanitizeForConsole } from "./console-sanitize.js";
export declare function buildApiErrorObservationFields(rawError?: string, opts?: {
    provider?: string;
}): {
    rawErrorPreview?: string;
    rawErrorHash?: string;
    rawErrorFingerprint?: string;
    httpCode?: string;
    providerRuntimeFailureKind?: ProviderRuntimeFailureKind;
    providerErrorType?: string;
    providerErrorMessagePreview?: string;
    requestIdHash?: string;
};
export declare function buildTextObservationFields(text?: string, opts?: {
    provider?: string;
}): {
    textPreview?: string;
    textHash?: string;
    textFingerprint?: string;
    httpCode?: string;
    providerRuntimeFailureKind?: ProviderRuntimeFailureKind;
    providerErrorType?: string;
    providerErrorMessagePreview?: string;
    requestIdHash?: string;
};
