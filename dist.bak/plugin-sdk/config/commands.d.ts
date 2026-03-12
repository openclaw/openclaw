import type { ChannelId } from "../channels/plugins/types.js";
import type { CommandsConfig, NativeCommandsSetting } from "./types.js";
export type CommandFlagKey = {
    [K in keyof CommandsConfig]-?: Exclude<CommandsConfig[K], undefined> extends boolean ? K : never;
}[keyof CommandsConfig];
export declare function resolveNativeSkillsEnabled(params: {
    providerId: ChannelId;
    providerSetting?: NativeCommandsSetting;
    globalSetting?: NativeCommandsSetting;
}): boolean;
export declare function resolveNativeCommandsEnabled(params: {
    providerId: ChannelId;
    providerSetting?: NativeCommandsSetting;
    globalSetting?: NativeCommandsSetting;
}): boolean;
export declare function isNativeCommandsExplicitlyDisabled(params: {
    providerSetting?: NativeCommandsSetting;
    globalSetting?: NativeCommandsSetting;
}): boolean;
export declare function isCommandFlagEnabled(config: {
    commands?: unknown;
} | undefined, key: CommandFlagKey): boolean;
export declare function isRestartEnabled(config?: {
    commands?: unknown;
}): boolean;
