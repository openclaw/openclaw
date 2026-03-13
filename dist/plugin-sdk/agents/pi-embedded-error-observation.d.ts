export declare function sanitizeForConsole(text: string | undefined, maxChars?: number): string | undefined;
export declare function buildApiErrorObservationFields(rawError?: string): {
    rawErrorPreview?: string;
    rawErrorHash?: string;
    rawErrorFingerprint?: string;
    httpCode?: string;
    providerErrorType?: string;
    providerErrorMessagePreview?: string;
    requestIdHash?: string;
};
export declare function buildTextObservationFields(text?: string): {
    textPreview?: string;
    textHash?: string;
    textFingerprint?: string;
    httpCode?: string;
    providerErrorType?: string;
    providerErrorMessagePreview?: string;
    requestIdHash?: string;
};
