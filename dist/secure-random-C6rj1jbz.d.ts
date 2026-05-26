//#region src/infra/secure-random.d.ts
declare function generateSecureUuid(): string;
declare function generateSecureToken(bytes?: number): string;
declare function generateSecureHex(bytes?: number): string;
/** Returns a cryptographically secure fraction in the range [0, 1). */
declare function generateSecureFraction(): number;
declare function generateSecureInt(maxExclusive: number): number;
declare function generateSecureInt(minInclusive: number, maxExclusive: number): number;
//#endregion
export { generateSecureUuid as a, generateSecureToken as i, generateSecureHex as n, generateSecureInt as r, generateSecureFraction as t };