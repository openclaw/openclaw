export type DirectDmPreCryptoGuardPolicy = {
    allowedKinds: readonly number[];
    maxFutureSkewSec: number;
    maxCiphertextBytes: number;
    maxPlaintextBytes: number;
    rateLimit: {
        windowMs: number;
        maxPerSenderPerWindow: number;
        maxGlobalPerWindow: number;
        maxTrackedSenderKeys: number;
    };
};
export type DirectDmPreCryptoGuardPolicyOverrides = Partial<Omit<DirectDmPreCryptoGuardPolicy, "rateLimit">> & {
    rateLimit?: Partial<DirectDmPreCryptoGuardPolicy["rateLimit"]>;
};
/** Shared policy object for DM-style pre-crypto guardrails. */
export declare function createDirectDmPreCryptoGuardPolicy(overrides?: DirectDmPreCryptoGuardPolicyOverrides): DirectDmPreCryptoGuardPolicy;
