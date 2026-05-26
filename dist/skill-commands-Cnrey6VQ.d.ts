import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { t as SkillCommandSpec } from "./skills-BRkHvK1T.js";

//#region src/auto-reply/skill-commands-base.d.ts
declare function listReservedChatSlashCommandNames(extraNames?: string[]): Set<string>;
declare function resolveSkillCommandInvocation(params: {
  commandBodyNormalized: string;
  skillCommands: SkillCommandSpec[];
}): {
  command: SkillCommandSpec;
  args?: string;
} | null;
//#endregion
//#region src/auto-reply/skill-commands.d.ts
declare function listSkillCommandsForWorkspace(params: {
  workspaceDir: string;
  cfg: OpenClawConfig;
  agentId?: string;
  skillFilter?: string[];
}): SkillCommandSpec[];
declare function listSkillCommandsForAgents(params: {
  cfg: OpenClawConfig;
  agentIds?: string[];
}): SkillCommandSpec[];
//#endregion
export { resolveSkillCommandInvocation as i, listSkillCommandsForWorkspace as n, listReservedChatSlashCommandNames as r, listSkillCommandsForAgents as t };