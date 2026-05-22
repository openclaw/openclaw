import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { DiscordAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { CommandWithSubcommands } from "../internal/discord.js";
import type { DiscordVoiceManager } from "./manager.js";
type VoiceCommandContext = {
    cfg: OpenClawConfig;
    discordConfig: DiscordAccountConfig;
    accountId: string;
    groupPolicy: "open" | "disabled" | "allowlist";
    useAccessGroups: boolean;
    getManager: () => DiscordVoiceManager | null;
    ephemeralDefault: boolean;
};
export declare function createDiscordVoiceCommand(params: VoiceCommandContext): CommandWithSubcommands;
export {};
