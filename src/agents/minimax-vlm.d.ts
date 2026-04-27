export declare function isMinimaxVlmProvider(provider: string): boolean;
export declare function isMinimaxVlmModel(provider: string, modelId: string): boolean;
export declare function minimaxUnderstandImage(params: {
    apiKey: string;
    prompt: string;
    imageDataUrl: string;
    apiHost?: string;
    modelBaseUrl?: string;
}): Promise<string>;
