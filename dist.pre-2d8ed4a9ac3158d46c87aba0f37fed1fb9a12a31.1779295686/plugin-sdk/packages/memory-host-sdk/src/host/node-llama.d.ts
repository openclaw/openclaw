export type LlamaEmbedding = {
    vector: Float32Array | number[];
};
export type LlamaEmbeddingContext = {
    getEmbeddingFor: (text: string) => Promise<LlamaEmbedding>;
    dispose?: () => Promise<void> | void;
};
export type LlamaModel = {
    createEmbeddingContext: (options?: {
        contextSize?: number | "auto";
        createSignal?: AbortSignal;
    }) => Promise<LlamaEmbeddingContext>;
    dispose?: () => Promise<void> | void;
};
export type ResolveModelFileOptions = {
    directory?: string;
    signal?: AbortSignal;
};
export type Llama = {
    loadModel: (params: {
        modelPath: string;
        loadSignal?: AbortSignal;
    }) => Promise<LlamaModel>;
    dispose?: () => Promise<void> | void;
};
export type NodeLlamaCppModule = {
    LlamaLogLevel: {
        error: number;
    };
    getLlama: (params: {
        logLevel: number;
    }) => Promise<Llama>;
    resolveModelFile: (modelPath: string, optionsOrDirectory?: string | ResolveModelFileOptions) => Promise<string>;
};
export declare function importNodeLlamaCpp(): Promise<NodeLlamaCppModule>;
