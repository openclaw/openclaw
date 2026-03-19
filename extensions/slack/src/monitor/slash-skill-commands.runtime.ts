import { listSkillCommandsForAgents as listSkillCommandsForAgentsImpl } from "openclaw/plugin-sdk/reply-runtime";

type ListSkillCommandsForAgents =
  typeof import("openclaw/plugin-sdk/reply-runtime").listSkillCommandsForAgents;

export function listSkillCommandsForAgents(
  ...args: Parameters<ListSkillCommandsForAgents>
): ReturnType<ListSkillCommandsForAgents> {
  return listSkillCommandsForAgentsImpl(...args);
}
