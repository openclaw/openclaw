import { i as OpenClawConfig } from "./types.openclaw-BdSNxnBz.js";
import { t as SkillCommandSpec } from "./skills-DNPVSPnu.js";

//#region src/auto-reply/command-status-builders.d.ts
declare function buildHelpMessage(cfg?: OpenClawConfig): string;
type CommandsMessageOptions = {
  page?: number;
  surface?: string;
  forcePaginatedList?: boolean;
};
type CommandsMessageResult = {
  text: string;
  totalPages: number;
  currentPage: number;
  hasNext: boolean;
  hasPrev: boolean;
};
declare function buildCommandsMessage(cfg?: OpenClawConfig, skillCommands?: SkillCommandSpec[], options?: CommandsMessageOptions): string;
declare function buildCommandsMessagePaginated(cfg?: OpenClawConfig, skillCommands?: SkillCommandSpec[], options?: CommandsMessageOptions): CommandsMessageResult;
//#endregion
export { buildHelpMessage as a, buildCommandsMessagePaginated as i, CommandsMessageResult as n, buildCommandsMessage as r, CommandsMessageOptions as t };