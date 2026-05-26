type LegacyInternalHookHandler = {
    event: string;
    module: string;
    export?: string;
};
export declare function getLegacyInternalHookHandlers(config: unknown): LegacyInternalHookHandler[];
export {};
