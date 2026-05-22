//#region extensions/whatsapp/src/security-contract.d.ts
type UnsupportedSecretRefConfigCandidate = {
  path: string;
  value: unknown;
};
declare const unsupportedSecretRefSurfacePatterns: readonly ["channels.whatsapp.creds.json", "channels.whatsapp.accounts.*.creds.json"];
declare function collectUnsupportedSecretRefConfigCandidates(raw: unknown): UnsupportedSecretRefConfigCandidate[];
//#endregion
export { unsupportedSecretRefSurfacePatterns as n, collectUnsupportedSecretRefConfigCandidates as t };