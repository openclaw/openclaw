import type { SkillCommandSpec } from "../agents/skills.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
export declare function buildHelpMessage(cfg?: OpenClawConfig): string;
export type CommandsMessageOptions = {
    page?: number;
    surface?: string;
    forcePaginatedList?: boolean;
};
export type CommandsMessageResult = {
    text: string;
    totalPages: number;
    currentPage: number;
    hasNext: boolean;
    hasPrev: boolean;
};
export declare function buildCommandsMessage(cfg?: OpenClawConfig, skillCommands?: SkillCommandSpec[], options?: CommandsMessageOptions): string;
export declare function buildCommandsMessagePaginated(cfg?: OpenClawConfig, skillCommands?: SkillCommandSpec[], options?: CommandsMessageOptions): CommandsMessageResult;
