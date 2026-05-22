import type { ChannelRuntimeSurface } from "openclaw/plugin-sdk/channel-contract";
import type { NativeCommandSpec } from "openclaw/plugin-sdk/command-auth-native";
import type { DiscordAccountConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { type BaseCommand, type BaseMessageInteractiveComponent, type Modal } from "../internal/discord.js";
import { createDiscordNativeCommand } from "./native-command.js";
import type { ThreadBindingManager } from "./thread-bindings.types.js";
type DiscordVoiceManager = import("../voice/manager.js").DiscordVoiceManager;
export declare function createDiscordProviderInteractionSurface(params: {
    cfg: OpenClawConfig;
    discordConfig: DiscordAccountConfig;
    accountId: string;
    token: string;
    commandSpecs: NativeCommandSpec[];
    nativeEnabled: boolean;
    voiceEnabled: boolean;
    groupPolicy: "open" | "disabled" | "allowlist";
    useAccessGroups: boolean;
    sessionPrefix: string;
    ephemeralDefault: boolean;
    threadBindings: ThreadBindingManager;
    voiceManagerRef: {
        current: DiscordVoiceManager | null;
    };
    guildEntries: DiscordAccountConfig["guilds"];
    allowFrom: DiscordAccountConfig["allowFrom"];
    dmPolicy: NonNullable<DiscordAccountConfig["dmPolicy"]>;
    runtime: RuntimeEnv;
    channelRuntime?: ChannelRuntimeSurface;
    abortSignal?: AbortSignal;
    createNativeCommand?: typeof createDiscordNativeCommand;
}): {
    commands: BaseCommand[];
    components: BaseMessageInteractiveComponent[];
    modals: Modal[];
};
export {};
