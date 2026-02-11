/**
 * Auto-detect Local LLM Configuration
 */
export interface DetectedLLM {
    provider: "ollama" | "llamacpp" | "localai";
    model: string;
    size: number;
    contextWindow: number;
    recommended: boolean;
    reason: string;
}
export interface LLMDetectorConfig {
    ollamaBaseUrl: string;
    minContextWindow: number;
    preferredModels: string[];
}
export declare function detectLocalLLMs(config?: Partial<LLMDetectorConfig>): Promise<DetectedLLM[]>;
export declare function selectBestLLM(purpose?: "compression" | "summarization" | "analysis"): Promise<DetectedLLM | null>;
export declare function generateConfig(): Promise<{
    enabled: boolean;
    compression: string;
    engines: {
        local: {
            provider: string;
            model: string;
            baseUrl?: string;
        };
    };
    detected: DetectedLLM[];
}>;
//# sourceMappingURL=auto-detect-llm.d.ts.map