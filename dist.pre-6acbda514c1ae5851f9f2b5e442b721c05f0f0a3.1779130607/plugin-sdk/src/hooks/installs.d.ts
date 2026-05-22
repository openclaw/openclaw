import type { HookInstallRecord } from "../config/types.hooks.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
export type HookInstallUpdate = HookInstallRecord & {
    hookId: string;
};
export declare function recordHookInstall(cfg: OpenClawConfig, update: HookInstallUpdate): OpenClawConfig;
