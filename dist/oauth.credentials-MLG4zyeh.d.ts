import { Dirent, existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";

//#region extensions/google/oauth.credentials.d.ts
type CredentialFs = {
  existsSync: (path: Parameters<typeof existsSync>[0]) => ReturnType<typeof existsSync>;
  readFileSync: (path: Parameters<typeof readFileSync>[0], encoding: "utf8") => string;
  realpathSync: (path: Parameters<typeof realpathSync>[0]) => string;
  readdirSync: (path: Parameters<typeof readdirSync>[0], options: {
    withFileTypes: true;
  }) => Dirent[];
};
declare function clearCredentialsCache(): void;
declare function setOAuthCredentialsFsForTest(overrides?: Partial<CredentialFs>): void;
declare function extractGeminiCliCredentials(): {
  clientId: string;
  clientSecret: string;
} | null;
declare function resolveOAuthClientConfig(): {
  clientId: string;
  clientSecret?: string;
};
//#endregion
export { setOAuthCredentialsFsForTest as i, extractGeminiCliCredentials as n, resolveOAuthClientConfig as r, clearCredentialsCache as t };