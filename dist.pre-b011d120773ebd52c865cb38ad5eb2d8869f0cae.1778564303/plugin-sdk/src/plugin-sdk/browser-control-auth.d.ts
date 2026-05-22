import type { OpenClawConfig } from "../config/types.openclaw.js";
export type BrowserControlAuth = {
    token?: string;
    password?: string;
};
type EnsureBrowserControlAuthParams = {
    cfg: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
};
type EnsureBrowserControlAuthResult = {
    auth: BrowserControlAuth;
    generatedToken?: string;
};
export declare function resolveBrowserControlAuth(cfg?: OpenClawConfig, env?: NodeJS.ProcessEnv): BrowserControlAuth;
export declare function shouldAutoGenerateBrowserAuth(env: NodeJS.ProcessEnv): boolean;
export declare function ensureBrowserControlAuth(params: EnsureBrowserControlAuthParams): Promise<EnsureBrowserControlAuthResult>;
export {};
