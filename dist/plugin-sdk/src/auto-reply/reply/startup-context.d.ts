import type { OpenClawConfig } from "../../config/config.js";
export declare function shouldApplyStartupContext(params: {
    cfg?: OpenClawConfig;
    action: "new" | "reset";
}): boolean;
export declare function buildSessionStartupContextPrelude(params: {
    workspaceDir: string;
    cfg?: OpenClawConfig;
    nowMs?: number;
}): Promise<string | null>;
