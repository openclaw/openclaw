// Skill Workshop Doctor: its settings moved from core `skills.workshop` into this plugin's config.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { asOptionalRecord as readRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

const PLUGIN_ID = "skill-workshop";

/** Detected before strict validation, so the refusal names the repair. */
export const legacyConfigRules = [
  {
    path: ["skills", "workshop"],
    message: `skills.workshop moved to plugins.entries.${PLUGIN_ID}.config. Run "openclaw doctor --fix".`,
  },
];

/** The settings this plugin owns; anything else under the retired key was already retired. */
function pickSettings(source: Record<string, unknown> | undefined) {
  const autonomous = readRecord(source?.autonomous);
  const picked: Record<string, unknown> = {};
  const pickedAutonomous: Record<string, unknown> = {};
  if (autonomous?.mode !== undefined) {
    pickedAutonomous.mode = autonomous.mode;
  }
  if (autonomous?.channelNotices !== undefined) {
    pickedAutonomous.channelNotices = autonomous.channelNotices;
  }
  if (Object.keys(pickedAutonomous).length > 0) {
    picked.autonomous = pickedAutonomous;
  }
  if (source?.maxSkillBytes !== undefined) {
    picked.maxSkillBytes = source.maxSkillBytes;
  }
  return picked;
}

/**
 * Moves `skills.workshop` into `plugins.entries.skill-workshop.config`. Settings already in the
 * plugin config win. Core Doctor rules have already mapped older Workshop shapes by this point.
 */
export function normalizeCompatibilityConfig({ cfg }: { cfg: OpenClawConfig }): {
  config: OpenClawConfig;
  changes: string[];
} {
  // The retired key is outside the canonical type; widen only to remove it.
  const next = structuredClone(cfg) as OpenClawConfig & { skills?: { workshop?: unknown } };
  if (!next.skills || !Object.hasOwn(next.skills, "workshop")) {
    return { config: cfg, changes: [] };
  }
  const entry = next.plugins?.entries?.[PLUGIN_ID];
  // An unmarked entry may be policy written while Workshop was built in; core Doctor repairs it
  // first in the same pass. Other passes leave the retired key flagged for that Doctor run.
  if (entry && next.meta?.migrations?.skillWorkshopPlugin !== true) {
    return { config: cfg, changes: [] };
  }
  const moved = pickSettings(readRecord(next.skills.workshop));
  delete next.skills.workshop;
  if (Object.keys(next.skills).length === 0) {
    delete next.skills;
  }
  const current = entry?.config ?? {};
  const config = {
    ...moved,
    ...current,
    ...(moved.autonomous || current.autonomous
      ? { autonomous: { ...readRecord(moved.autonomous), ...readRecord(current.autonomous) } }
      : {}),
  };
  next.plugins = {
    ...next.plugins,
    entries: { ...next.plugins?.entries, [PLUGIN_ID]: { ...entry, config } },
  };
  // Nothing older is left to repair, so the marker keeps later passes from dropping this entry.
  next.meta = { ...next.meta, migrations: { ...next.meta?.migrations, skillWorkshopPlugin: true } };
  return {
    config: next,
    changes: [`Moved skills.workshop to plugins.entries.${PLUGIN_ID}.config.`],
  };
}
