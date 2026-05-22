import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
export declare function applyQaSetup(params: {
    cfg: OpenClawConfig;
    accountId: string;
    input: Record<string, unknown>;
}): OpenClawConfig;
