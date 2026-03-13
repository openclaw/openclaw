export declare function normalizeApiKeyInput(raw: string): string;
export declare const validateApiKeyInput: (value: string) => "Required" | undefined;
export declare function formatApiKeyPreview(raw: string, opts?: {
    head?: number;
    tail?: number;
}): string;
