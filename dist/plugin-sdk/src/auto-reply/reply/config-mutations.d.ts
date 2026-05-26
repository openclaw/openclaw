import type { OpenClawConfig } from "../../config/types.openclaw.js";
export declare class AutoReplyConfigMutationError extends Error {
}
export declare function formatAutoReplyConfigMutationError(error: unknown): string | null;
export declare function unsetConfigPath(path: string[]): Promise<boolean>;
export declare function setConfigPath(path: string[], value: unknown): Promise<void>;
export declare function setPluginEnabledFromCommand(params: {
    pluginId: string;
    enabled: boolean;
    action: "enable" | "disable";
}): Promise<OpenClawConfig>;
type AllowlistConfigEditResult = {
    kind?: "ok" | "invalid-entry";
    changed?: boolean;
} | null | undefined;
type MaybePromise<T> = T | Promise<T>;
type ApplyAllowlistConfigEdit = (params: {
    cfg: OpenClawConfig;
    parsedConfig: Record<string, unknown>;
    accountId?: string | null;
    scope: "dm" | "group";
    action: "add" | "remove";
    entry: string;
}) => MaybePromise<AllowlistConfigEditResult>;
export declare function applyAllowlistConfigMutation(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    scope: "dm" | "group";
    action: "add" | "remove";
    entry: string;
    applyConfigEdit: ApplyAllowlistConfigEdit;
}): Promise<void>;
export {};
