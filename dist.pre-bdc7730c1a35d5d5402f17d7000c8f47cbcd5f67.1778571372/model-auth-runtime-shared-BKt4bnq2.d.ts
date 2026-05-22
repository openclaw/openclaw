//#region src/agents/model-auth-runtime-shared.d.ts
type ResolvedProviderAuth = {
  apiKey?: string;
  profileId?: string;
  source: string;
  mode: "api-key" | "oauth" | "token" | "aws-sdk";
};
declare function resolveAwsSdkEnvVarName(env?: NodeJS.ProcessEnv): string | undefined;
declare function requireApiKey(auth: ResolvedProviderAuth, provider: string): string;
//#endregion
export { requireApiKey as n, resolveAwsSdkEnvVarName as r, ResolvedProviderAuth as t };