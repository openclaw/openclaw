import { listSkillCommandsForAgents as listSkillCommandsForAgentsImpl } from "mullusi/plugin-sdk/command-auth";

type ListSkillCommandsForAgents =
  typeof import("mullusi/plugin-sdk/command-auth").listSkillCommandsForAgents;

export function listSkillCommandsForAgents(
  ...args: Parameters<ListSkillCommandsForAgents>
): ReturnType<ListSkillCommandsForAgents> {
  return listSkillCommandsForAgentsImpl(...args);
}
