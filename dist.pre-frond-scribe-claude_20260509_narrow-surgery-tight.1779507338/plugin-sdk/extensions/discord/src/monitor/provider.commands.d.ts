import { listNativeCommandSpecsForConfig, listSkillCommandsForAgents, type NativeCommandSpec } from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
export type GetPluginCommandSpecs = typeof import("openclaw/plugin-sdk/plugin-runtime").getPluginCommandSpecs;
export declare function resolveDiscordProviderCommandSpecs(params: {
    cfg: OpenClawConfig;
    runtime: RuntimeEnv;
    nativeEnabled: boolean;
    nativeSkillsEnabled: boolean;
    maxDiscordCommands?: number;
    listSkillCommandsForAgents?: typeof listSkillCommandsForAgents;
    listNativeCommandSpecsForConfig?: typeof listNativeCommandSpecsForConfig;
    getPluginCommandSpecs?: GetPluginCommandSpecs;
}): Promise<{
    skillCommands: ReturnType<typeof listSkillCommandsForAgents>;
    commandSpecs: NativeCommandSpec[];
}>;
