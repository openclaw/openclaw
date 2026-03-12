import { CommandWithSubcommands } from "@buape/carbon";
import type { OpenClawConfig } from "../../config/config.js";
import type { DiscordAccountConfig } from "../../config/types.js";
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
