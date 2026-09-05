import { bindWorkspaceSkillUsage } from "../skills/runtime/run-usage.js";
import type { OperationalRunInstanceRef } from "./admitted-run-context.js";

export type StubPreparedContext = {
  params: { admittedRunContext: { operationalRunInstance: OperationalRunInstanceRef } };
};

export const selectedSkillFile = "/tmp/test-workspace/skills/selected/SKILL.md";
export const unselectedSkillFile = "/tmp/test-workspace/skills/unselected/SKILL.md";

export const skillsSnapshot = {
  prompt: "",
  skills: [],
  resolvedSkillCommands: [
    {
      selectionPath: selectedSkillFile,
      skillFile: selectedSkillFile,
      skillName: "selected",
      skillSource: "workspace" as const,
    },
    {
      selectionPath: unselectedSkillFile,
      skillFile: unselectedSkillFile,
      skillName: "unselected",
      skillSource: "workspace" as const,
    },
  ],
};

export function readStubRunInstance(context: unknown): OperationalRunInstanceRef {
  return (context as StubPreparedContext).params.admittedRunContext.operationalRunInstance;
}

export function hasStubSkillReceipt(
  operationalRunInstance: OperationalRunInstanceRef | undefined,
  skillFile: string,
): boolean {
  return bindWorkspaceSkillUsage({ operationalRunInstance, skillFile })?.() === true;
}
