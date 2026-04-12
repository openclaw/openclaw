import type { OpenClawConfig } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { requiresMandatorySandboxForTier } from "../sandbox/mandatory-sandbox.js";
import { loadWorkspaceSkillEntries, type SkillEntry, type SkillSnapshot } from "../skills.js";

const log = createSubsystemLogger("skills");

// RI-030 spawn-side activation (Block 1.5 item #4). When the current session
// is NOT sandboxed, any skill whose cert_tier requires mandatory sandbox gets
// dropped from the loaded set and a loud warning is logged with the skill
// name + cert_tier + remediation. Missing cert_tier is treated as trusted —
// the entire bundled-framework skill catalog predates cert_tier and must
// keep working. Only skills explicitly marked unverified (or with an unknown
// cert_tier value that the loader surfaces) are subject to the filter.
function filterEntriesByMandatorySandbox(params: {
  entries: SkillEntry[];
  sandboxed: boolean;
}): SkillEntry[] {
  if (params.sandboxed) {
    return params.entries;
  }
  const kept: SkillEntry[] = [];
  for (const entry of params.entries) {
    const certTier = entry.metadata?.certTier;
    if (!certTier) {
      // No cert_tier declared — trust the skill (backwards compatibility for
      // every pre-RI-030 skill in the bundled catalog).
      kept.push(entry);
      continue;
    }
    const decision = requiresMandatorySandboxForTier(certTier);
    if (!decision.required) {
      kept.push(entry);
      continue;
    }
    log.warn(
      `Skill "${entry.skill.name}" dropped: cert_tier="${certTier}" requires mandatory sandbox but current session is not sandboxed. ` +
        `Reason: ${decision.reason}. ` +
        `Fix: enable sandbox for this agent (agents.defaults.sandbox.mode=all) or install a certified/verified build from ClawHub.`,
    );
  }
  return kept;
}

export function resolveEmbeddedRunSkillEntries(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  skillsSnapshot?: SkillSnapshot;
  sandboxed?: boolean;
}): {
  shouldLoadSkillEntries: boolean;
  skillEntries: SkillEntry[];
} {
  const shouldLoadSkillEntries = !params.skillsSnapshot || !params.skillsSnapshot.resolvedSkills;
  if (!shouldLoadSkillEntries) {
    return { shouldLoadSkillEntries, skillEntries: [] };
  }
  const loaded = loadWorkspaceSkillEntries(params.workspaceDir, { config: params.config });
  const filtered = filterEntriesByMandatorySandbox({
    entries: loaded,
    sandboxed: params.sandboxed ?? false,
  });
  return { shouldLoadSkillEntries, skillEntries: filtered };
}
