//#region extensions/whatsapp/src/session-contract.d.ts
declare function isLegacyGroupSessionKey(key: string): boolean;
declare function canonicalizeLegacySessionKey(params: {
  key: string;
  agentId: string;
}): string | null;
//#endregion
export { isLegacyGroupSessionKey as n, canonicalizeLegacySessionKey as t };