/**
 * Direct SDK/HTTP calls for providers that support native PDF document input.
 * This bypasses pi-ai's content type system which does not have a "document" type.
 */
type PdfInput = {
    base64: string;
    filename?: string;
};
export declare function anthropicAnalyzePdf(params: {
    apiKey: string;
    modelId: string;
    prompt: string;
    pdfs: PdfInput[];
    maxTokens?: number;
    baseUrl?: string;
}): Promise<string>;
export declare function geminiAnalyzePdf(params: {
    apiKey: string;
    modelId: string;
    prompt: string;
    pdfs: PdfInput[];
    baseUrl?: string;
}): Promise<string>;
export {};
