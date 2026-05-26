//#region extensions/google/oauth.project.d.ts
declare function resolveGoogleOAuthIdentity(accessToken: string): Promise<{
  email?: string;
  projectId?: string;
}>;
declare function resolveGooglePersonalOAuthIdentity(accessToken: string): Promise<{
  email?: string;
  projectId?: string;
}>;
//#endregion
export { resolveGoogleOAuthIdentity, resolveGooglePersonalOAuthIdentity };