declare class GatewayIdentifyLimiter {
    private nextAllowedAtByKey;
    wait(params: {
        shardId?: number;
        maxConcurrency?: number;
    }): Promise<void>;
    reset(): void;
}
export declare const sharedGatewayIdentifyLimiter: GatewayIdentifyLimiter;
export {};
