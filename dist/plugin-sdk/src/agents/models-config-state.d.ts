type ModelsJsonState = {
    writeLocks: Map<string, Promise<void>>;
    readyCache: Map<string, Promise<{
        fingerprint: string;
        result: {
            agentDir: string;
            wrote: boolean;
        };
    }>>;
};
export declare const MODELS_JSON_STATE: ModelsJsonState;
export declare function resetModelsJsonReadyCacheForTest(): void;
export {};
