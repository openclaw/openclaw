//#region extensions/openai/openai-codex-auth-identity.d.ts
declare function resolveCodexAccessTokenExpiry(accessToken: string): number | undefined;
declare function resolveCodexAuthIdentity(params: {
  accessToken: string;
  email?: string | null;
}): {
  accountId?: string;
  chatgptPlanType?: string;
  email?: string;
  profileName?: string;
};
//#endregion
export { resolveCodexAccessTokenExpiry, resolveCodexAuthIdentity };