import { Skill } from "@earendil-works/pi-coding-agent";

//#region src/agents/skills/skill-contract.d.ts
type Skill$1 = Skill & {
  source?: string;
};
//#endregion
//#region src/agents/skills/types.d.ts
type SkillCommandDispatchSpec = {
  kind: "tool"; /** Name of the tool to invoke (AnyAgentTool.name). */
  toolName: string;
  /**
   * How to forward user-provided args to the tool.
   * - raw: forward the raw args string (no core parsing).
   */
  argMode?: "raw";
};
type SkillCommandSpec = {
  name: string;
  skillName: string;
  description: string; /** Localized descriptions for native command surfaces that support them. */
  descriptionLocalizations?: Record<string, string>; /** Optional deterministic dispatch behavior for this command. */
  dispatch?: SkillCommandDispatchSpec; /** Native prompt template used by Claude-bundle command markdown files. */
  promptTemplate?: string; /** Source markdown path for bundle-backed commands. */
  sourceFilePath?: string;
};
type SkillSnapshot = {
  prompt: string;
  skills: Array<{
    name: string;
    primaryEnv?: string;
    requiredEnv?: string[];
  }>; /** Normalized agent-level filter used to build this snapshot; undefined means unrestricted. */
  skillFilter?: string[];
  resolvedSkills?: Skill$1[];
  version?: number;
};
//#endregion
export { SkillSnapshot as n, SkillCommandSpec as t };