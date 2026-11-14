// Data of the plugin notice a background skill review posts after changing learned skills.
// The row's text serves every client; the data lets the Control UI render it natively. The
// Control UI reads the same shape through src/shared/skill-workshop-change-notice.ts.

export const SKILL_WORKSHOP_CHANGE_NOTICE_TYPE = "skills-changed";

export type SkillWorkshopNoticeAction = "created" | "updated" | "archived" | "restored";

export type SkillWorkshopChangeNoticeSkill = {
  name: string;
  action: SkillWorkshopNoticeAction;
  summary?: string;
};

export type SkillWorkshopChangeNotice = {
  agentId: string;
  /** The background review's run id; `skills.workshop.undo` reverts all of its changes. */
  runId: string;
  skills: SkillWorkshopChangeNoticeSkill[];
};
