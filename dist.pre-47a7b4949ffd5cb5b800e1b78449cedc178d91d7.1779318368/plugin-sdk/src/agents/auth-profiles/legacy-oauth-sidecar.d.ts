declare const LEGACY_OAUTH_REF_SOURCE = "openclaw-credentials";
declare const LEGACY_OAUTH_REF_PROVIDER = "openai-codex";
declare const LEGACY_OAUTH_SECRET_ALGORITHM = "aes-256-gcm";
export type LegacyOAuthRef = {
    source: typeof LEGACY_OAUTH_REF_SOURCE;
    provider: typeof LEGACY_OAUTH_REF_PROVIDER;
    id: string;
};
export type LegacyOAuthSecretMaterial = {
    access?: string;
    refresh?: string;
    idToken?: string;
};
type LegacyOAuthEncryptedPayload = {
    algorithm: typeof LEGACY_OAUTH_SECRET_ALGORITHM;
    iv: string;
    tag: string;
    ciphertext: string;
};
export declare function isLegacyOAuthRef(value: unknown): value is LegacyOAuthRef;
export declare function resolveLegacyOAuthSidecarPath(ref: LegacyOAuthRef, env?: NodeJS.ProcessEnv): string;
export declare function isLegacyOAuthSidecarPayload(raw: unknown): boolean;
declare function buildLegacyOAuthSecretAad(params: {
    ref: LegacyOAuthRef;
    profileId: string;
    provider: string;
}): Buffer;
declare function buildLegacyOAuthSecretKey(seed: string): Buffer;
declare function encryptLegacyOAuthMaterialForTest(params: {
    ref: LegacyOAuthRef;
    profileId: string;
    provider: string;
    seed: string;
    material: Record<string, string>;
}): LegacyOAuthEncryptedPayload;
export declare function loadLegacyOAuthSidecarMaterial(params: {
    ref: LegacyOAuthRef;
    profileId: string;
    provider: string;
    allowKeychainPrompt?: boolean;
    env?: NodeJS.ProcessEnv;
}): LegacyOAuthSecretMaterial | null;
export declare const legacyOAuthSidecarTestUtils: {
    buildLegacyOAuthSecretAad: typeof buildLegacyOAuthSecretAad;
    buildLegacyOAuthSecretKey: typeof buildLegacyOAuthSecretKey;
    encryptLegacyOAuthMaterial: typeof encryptLegacyOAuthMaterialForTest;
};
export {};
