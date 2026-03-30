import type { AuthProfileCredential, AuthProfileStore } from "./auth-profiles.js";
export type PiApiKeyCredential = {
    type: "api_key";
    key: string;
};
export type PiOAuthCredential = {
    type: "oauth";
    access: string;
    refresh: string;
    expires: number;
};
export type PiCredential = PiApiKeyCredential | PiOAuthCredential;
export type PiCredentialMap = Record<string, PiCredential>;
export declare function convertAuthProfileCredentialToPi(cred: AuthProfileCredential): PiCredential | null;
export declare function resolvePiCredentialMapFromStore(store: AuthProfileStore): PiCredentialMap;
export declare function piCredentialsEqual(a: PiCredential | undefined, b: PiCredential): boolean;
