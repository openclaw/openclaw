//#region extensions/discord/src/security-contract.d.ts
type UnsupportedSecretRefConfigCandidate = {
  path: string;
  value: unknown;
};
declare const unsupportedSecretRefSurfacePatterns: readonly ["channels.discord.threadBindings.webhookToken", "channels.discord.accounts.*.threadBindings.webhookToken"];
declare function collectUnsupportedSecretRefConfigCandidates(raw: unknown): UnsupportedSecretRefConfigCandidate[];
//#endregion
export { unsupportedSecretRefSurfacePatterns as n, collectUnsupportedSecretRefConfigCandidates as t };