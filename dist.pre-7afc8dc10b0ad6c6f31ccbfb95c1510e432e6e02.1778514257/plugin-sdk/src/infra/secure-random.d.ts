export declare function generateSecureUuid(): string;
/**
 * Returns a UUIDv7 (RFC 9562) — time-ordered 128-bit identifier whose
 * first 48 bits are the unix-milliseconds timestamp at mint time. Used
 * for `SessionEntry.continuationChainId`: chain.id is minted on the 0->1
 * transition of `continuationChainCount` and stays stable for the lifetime of
 * the chain, so journal greps + sort-by-id give chronological order without a
 * separate timestamp lookup.
 *
 * Why v7 and not v4: lexicographic ordering preserved across mints,
 * downstream OTEL collectors (Jaeger/Tempo) parse UUID-shape natively,
 * and `uuid@14` is already a direct dependency.
 */
export declare function generateChainId(): string;
export declare function generateSecureToken(bytes?: number): string;
export declare function generateSecureHex(bytes?: number): string;
/** Returns a cryptographically secure fraction in the range [0, 1). */
export declare function generateSecureFraction(): number;
export declare function generateSecureInt(maxExclusive: number): number;
export declare function generateSecureInt(minInclusive: number, maxExclusive: number): number;
