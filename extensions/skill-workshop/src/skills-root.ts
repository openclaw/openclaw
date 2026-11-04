import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveSkillsRoot } from "openclaw/plugin-sdk/skill-authoring-runtime";

/** The manifest's `agentSkillsDir` for one agent; discovery loads the same per-agent folder. */
export function resolveWorkshopSkillsDir(config: OpenClawConfig, agentId: string): string {
  return resolveSkillsRoot({ config, agentId });
}

/** Drafts a background review proposed instead of changing skills; discovery never loads them. */
export const WORKSHOP_DRAFTS_DIR = ".drafts";

export function resolveWorkshopDraftsDir(config: OpenClawConfig, agentId: string): string {
  return path.join(resolveWorkshopSkillsDir(config, agentId), WORKSHOP_DRAFTS_DIR);
}
