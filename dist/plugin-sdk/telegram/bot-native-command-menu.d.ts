import type { Bot } from "grammy";
import type { RuntimeEnv } from "../runtime.js";
export declare const TELEGRAM_MAX_COMMANDS = 100;
export type TelegramMenuCommand = {
    command: string;
    description: string;
};
type TelegramPluginCommandSpec = {
    name: unknown;
    description: unknown;
};
export declare function buildPluginTelegramMenuCommands(params: {
    specs: TelegramPluginCommandSpec[];
    existingCommands: Set<string>;
}): {
    commands: TelegramMenuCommand[];
    issues: string[];
};
export declare function buildCappedTelegramMenuCommands(params: {
    allCommands: TelegramMenuCommand[];
    maxCommands?: number;
}): {
    commandsToRegister: TelegramMenuCommand[];
    totalCommands: number;
    maxCommands: number;
    overflowCount: number;
};
/** Compute a stable hash of the command list for change detection. */
export declare function hashCommandList(commands: TelegramMenuCommand[]): string;
export declare function syncTelegramMenuCommands(params: {
    bot: Bot;
    runtime: RuntimeEnv;
    commandsToRegister: TelegramMenuCommand[];
    accountId?: string;
    botIdentity?: string;
}): void;
export {};
