import type { ConfigFileSnapshot, OpenClawConfig } from "./types.js";
export declare const ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV = "OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS";
export type FutureConfigActionBlock = {
    action: string;
    currentVersion: string;
    touchedVersion: string;
    message: string;
    hints: string[];
};
type FutureConfigGuardParams = {
    action: string;
    snapshot?: Pick<ConfigFileSnapshot, "config" | "sourceConfig"> | null;
    config?: Pick<OpenClawConfig, "meta"> | null;
    currentVersion?: string;
    env?: Record<string, string | undefined>;
};
export declare function resolveFutureConfigActionBlock(params: FutureConfigGuardParams): FutureConfigActionBlock | null;
export declare function formatFutureConfigActionBlock(block: FutureConfigActionBlock): string;
export {};
