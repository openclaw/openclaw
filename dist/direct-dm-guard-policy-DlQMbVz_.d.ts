//#region src/plugin-sdk/direct-dm-guard-policy.d.ts
type DirectDmPreCryptoGuardPolicy = {
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
type DirectDmPreCryptoGuardPolicyOverrides = Partial<Omit<DirectDmPreCryptoGuardPolicy, "rateLimit">> & {
  rateLimit?: Partial<DirectDmPreCryptoGuardPolicy["rateLimit"]>;
};
/** Shared policy object for DM-style pre-crypto guardrails. */
declare function createDirectDmPreCryptoGuardPolicy(overrides?: DirectDmPreCryptoGuardPolicyOverrides): DirectDmPreCryptoGuardPolicy;
//#endregion
export { DirectDmPreCryptoGuardPolicyOverrides as n, createDirectDmPreCryptoGuardPolicy as r, DirectDmPreCryptoGuardPolicy as t };