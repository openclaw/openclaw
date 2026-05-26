import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
//#region extensions/browser/src/browser/control-auth.d.ts
type BrowserControlAuth = {
  token?: string;
  password?: string;
};
declare function resolveBrowserControlAuth(cfg?: OpenClawConfig, env?: NodeJS.ProcessEnv): BrowserControlAuth;
declare function shouldAutoGenerateBrowserAuth(env: NodeJS.ProcessEnv): boolean;
declare function ensureBrowserControlAuth(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  auth: BrowserControlAuth;
  generatedToken?: string;
}>;
//#endregion
export { shouldAutoGenerateBrowserAuth as i, ensureBrowserControlAuth as n, resolveBrowserControlAuth as r, BrowserControlAuth as t };