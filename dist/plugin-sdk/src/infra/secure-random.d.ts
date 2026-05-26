export declare function generateSecureUuid(): string;
export declare function generateSecureToken(bytes?: number): string;
export declare function generateSecureHex(bytes?: number): string;
/** Returns a cryptographically secure fraction in the range [0, 1). */
export declare function generateSecureFraction(): number;
export declare function generateSecureInt(maxExclusive: number): number;
export declare function generateSecureInt(minInclusive: number, maxExclusive: number): number;
