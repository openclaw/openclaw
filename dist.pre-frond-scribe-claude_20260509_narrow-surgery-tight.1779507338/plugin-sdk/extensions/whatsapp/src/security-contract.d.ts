type UnsupportedSecretRefConfigCandidate = {
    path: string;
    value: unknown;
};
export declare const unsupportedSecretRefSurfacePatterns: readonly ["channels.whatsapp.creds.json", "channels.whatsapp.accounts.*.creds.json"];
export declare function collectUnsupportedSecretRefConfigCandidates(raw: unknown): UnsupportedSecretRefConfigCandidate[];
export {};
