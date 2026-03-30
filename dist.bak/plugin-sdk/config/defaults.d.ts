import type { OpenClawConfig } from "./types.js";
type WarnState = {
    warned: boolean;
};
export type SessionDefaultsOptions = {
    warn?: (message: string) => void;
    warnState?: WarnState;
};
export declare function applyMessageDefaults(cfg: OpenClawConfig): OpenClawConfig;
export declare function applySessionDefaults(cfg: OpenClawConfig, options?: SessionDefaultsOptions): OpenClawConfig;
export declare function applyTalkApiKey(config: OpenClawConfig): OpenClawConfig;
export declare function applyTalkConfigNormalization(config: OpenClawConfig): OpenClawConfig;
export declare function applyModelDefaults(cfg: OpenClawConfig): OpenClawConfig;
export declare function applyAgentDefaults(cfg: OpenClawConfig): OpenClawConfig;
export declare function applyLoggingDefaults(cfg: OpenClawConfig): OpenClawConfig;
export declare function applyContextPruningDefaults(cfg: OpenClawConfig): OpenClawConfig;
export declare function applyCompactionDefaults(cfg: OpenClawConfig): OpenClawConfig;
export declare function resetSessionDefaultsWarningForTests(): void;
export {};
