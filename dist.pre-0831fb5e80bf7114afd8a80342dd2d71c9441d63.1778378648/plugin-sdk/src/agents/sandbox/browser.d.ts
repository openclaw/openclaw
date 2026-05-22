import { type SsrFPolicy } from "../../infra/net/ssrf.js";
import type { SandboxBrowserContext, SandboxConfig } from "./types.js";
export declare function ensureSandboxBrowser(params: {
    scopeKey: string;
    workspaceDir: string;
    agentWorkspaceDir: string;
    cfg: SandboxConfig;
    evaluateEnabled?: boolean;
    bridgeAuth?: {
        token?: string;
        password?: string;
    };
    ssrfPolicy?: SsrFPolicy;
}): Promise<SandboxBrowserContext | null>;
