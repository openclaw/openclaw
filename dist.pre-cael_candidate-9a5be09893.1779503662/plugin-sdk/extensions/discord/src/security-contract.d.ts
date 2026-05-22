type UnsupportedSecretRefConfigCandidate = {
    path: string;
    value: unknown;
};
export declare const unsupportedSecretRefSurfacePatterns: readonly ["channels.discord.threadBindings.webhookToken", "channels.discord.accounts.*.threadBindings.webhookToken"];
export declare function collectUnsupportedSecretRefConfigCandidates(raw: unknown): UnsupportedSecretRefConfigCandidate[];
export {};
