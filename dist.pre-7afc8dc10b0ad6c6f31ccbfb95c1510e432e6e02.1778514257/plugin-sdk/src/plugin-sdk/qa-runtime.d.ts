type QaRuntimeSurface = {
    defaultQaRuntimeModelForMode: (mode: string, options?: {
        alternate?: boolean;
        preferredLiveModel?: string;
    }) => string;
    startQaLiveLaneGateway: (...args: unknown[]) => Promise<unknown>;
};
export declare function loadQaRuntimeModule(): QaRuntimeSurface;
export declare function isQaRuntimeAvailable(): boolean;
export {};
