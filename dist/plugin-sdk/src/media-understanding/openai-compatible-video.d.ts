export type OpenAiCompatibleVideoPayload = {
    choices?: Array<{
        message?: {
            content?: string | Array<{
                text?: string;
            }>;
            reasoning_content?: string;
        };
    }>;
};
export declare function resolveMediaUnderstandingString(value: string | undefined, fallback: string): string;
export declare function coerceOpenAiCompatibleVideoText(payload: OpenAiCompatibleVideoPayload): string | null;
export declare function buildOpenAiCompatibleVideoRequestBody(params: {
    model: string;
    prompt: string;
    mime: string;
    buffer: Buffer;
}): {
    model: string;
    messages: {
        role: string;
        content: ({
            type: string;
            text: string;
            video_url?: undefined;
        } | {
            text?: undefined;
            type: string;
            video_url: {
                url: string;
            };
        })[];
    }[];
};
