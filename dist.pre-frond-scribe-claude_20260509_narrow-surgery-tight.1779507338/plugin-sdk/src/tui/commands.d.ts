import type { SlashCommand } from "@earendil-works/pi-tui";
import type { OpenClawConfig } from "../config/types.js";
import type { CommandEntry } from "../gateway/protocol/index.js";
export type ParsedCommand = {
    name: string;
    args: string;
};
export type SlashCommandOptions = {
    cfg?: OpenClawConfig;
    provider?: string;
    model?: string;
    thinkingLevels?: Array<{
        id: string;
        label: string;
    }>;
    local?: boolean;
    dynamicCommands?: CommandEntry[];
};
export declare function parseCommand(input: string): ParsedCommand;
export declare function getSlashCommands(options?: SlashCommandOptions): SlashCommand[];
export declare function helpText(options?: SlashCommandOptions): string;
