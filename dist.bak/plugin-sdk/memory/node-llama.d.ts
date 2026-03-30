export declare function importNodeLlamaCpp(): Promise<{
    default: typeof import("node-llama-cpp");
    getLlama(params: {
        logLevel: import("node-llama-cpp").LlamaLogLevel;
    }): Promise<import("node-llama-cpp").Llama>;
    resolveModelFile(modelPath: string, cacheDir?: string): Promise<string>;
    LlamaLogLevel: typeof import("node-llama-cpp").LlamaLogLevel;
}>;
