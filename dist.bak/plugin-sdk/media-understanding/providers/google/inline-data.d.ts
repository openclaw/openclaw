export declare function generateGeminiInlineDataText(params: {
    buffer: Buffer;
    mime?: string;
    apiKey: string;
    baseUrl?: string;
    headers?: Record<string, string>;
    model?: string;
    prompt?: string;
    timeoutMs: number;
    fetchFn?: typeof fetch;
    defaultBaseUrl: string;
    defaultModel: string;
    defaultPrompt: string;
    defaultMime: string;
    httpErrorLabel: string;
    missingTextError: string;
}): Promise<{
    text: string;
    model: string;
}>;
