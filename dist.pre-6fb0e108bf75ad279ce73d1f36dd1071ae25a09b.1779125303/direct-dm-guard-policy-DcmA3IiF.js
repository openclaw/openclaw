//#region src/plugin-sdk/direct-dm-guard-policy.ts
/** Shared policy object for DM-style pre-crypto guardrails. */
function createDirectDmPreCryptoGuardPolicy(overrides = {}) {
	return {
		allowedKinds: overrides.allowedKinds ?? [4],
		maxFutureSkewSec: overrides.maxFutureSkewSec ?? 120,
		maxCiphertextBytes: overrides.maxCiphertextBytes ?? 16 * 1024,
		maxPlaintextBytes: overrides.maxPlaintextBytes ?? 8 * 1024,
		rateLimit: {
			windowMs: overrides.rateLimit?.windowMs ?? 6e4,
			maxPerSenderPerWindow: overrides.rateLimit?.maxPerSenderPerWindow ?? 20,
			maxGlobalPerWindow: overrides.rateLimit?.maxGlobalPerWindow ?? 200,
			maxTrackedSenderKeys: overrides.rateLimit?.maxTrackedSenderKeys ?? 4096
		}
	};
}
//#endregion
export { createDirectDmPreCryptoGuardPolicy as t };
