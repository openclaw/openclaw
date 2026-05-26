type RequesterStoreKeyConfig = {
    session?: {
        mainKey?: string;
    };
    agents?: {
        list?: Array<{
            id?: string;
            default?: boolean;
        }>;
    };
};
export declare function resolveRequesterStoreKey(cfg: RequesterStoreKeyConfig | undefined, requesterSessionKey: string): string;
export {};
