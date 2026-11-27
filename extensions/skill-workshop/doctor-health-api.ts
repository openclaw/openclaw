import { listAgentIds } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { HealthCheck, HealthFinding } from "openclaw/plugin-sdk/health";
import { resolveEffectiveEnableState } from "openclaw/plugin-sdk/plugin-config-runtime";
import { resolveSkillWorkshopConfig } from "./src/config.js";
import {
  detectSkillWorkshopToolPolicyDiagnostic,
  type ExplainToolAvailability,
} from "./src/tool-policy-diagnostic.js";

// Light Doctor artifact: core loads it through the bundled health-check bridge even while the
// plugin is disabled, so it can report that the plugin itself is switched off.
const SKILL_WORKSHOP_TOOL_POLICY_CHECK_ID = "skill-workshop/tool-policy";

/** Skill Workshop needs its review tool whenever its plugin is active. */
function createSkillWorkshopToolPolicyCheck(
  explainToolAvailability: ExplainToolAvailability,
): HealthCheck {
  return {
    id: SKILL_WORKSHOP_TOOL_POLICY_CHECK_ID,
    kind: "plugin",
    source: "skill-workshop",
    description: "Autonomous Skill Workshop capture has a callable review tool.",
    async detect(ctx) {
      // Plugin activation (plugins.enabled, allow, deny, entries) decides first: an absent
      // autonomous mode defaults to auto, which is no evidence the operator wants a plugin they
      // excluded. Findings only apply while the plugin can actually load.
      const pluginActive = resolveEffectiveEnableState({
        id: "skill-workshop",
        origin: "bundled",
        rootConfig: ctx.cfg,
        enabledByDefault: true,
      }).enabled;
      const workshopEnabled =
        pluginActive && resolveSkillWorkshopConfig(ctx.cfg).autonomous.mode !== "off";
      const listedAgentIds = listAgentIds(ctx.cfg);
      const diagnostics = (
        await Promise.all(
          (listedAgentIds.length > 0 ? listedAgentIds : [undefined]).map((agentId) =>
            detectSkillWorkshopToolPolicyDiagnostic({
              explainToolAvailability,
              config: ctx.cfg,
              workshopEnabled,
              ...(agentId ? { agentId } : {}),
            }),
          ),
        )
      ).filter((diagnostic) => diagnostic !== null);
      const policyFindings: HealthFinding[] = diagnostics.map((diagnostic) => ({
        checkId: SKILL_WORKSHOP_TOOL_POLICY_CHECK_ID,
        category: "fix-now",
        docsUrl: "https://docs.openclaw.ai/tools/skill-workshop",
        severity: "warning",
        message: diagnostic.detail,
        path: diagnostic.source,
        target: diagnostic.agentId,
        requirement: "Autonomous Skill Workshop review requires the skill_workshop tool.",
        fixHint: diagnostic.fix,
      }));
      return policyFindings;
    },
  };
}

/** Registers the Workshop Doctor check once; the bridge passes core's tool explainer. */
export function registerSkillWorkshopDoctorChecks(host: {
  getHealthCheck: (id: string) => HealthCheck | undefined;
  registerHealthCheck: (check: HealthCheck) => void;
  explainToolAvailability: ExplainToolAvailability;
}): void {
  if (host.getHealthCheck(SKILL_WORKSHOP_TOOL_POLICY_CHECK_ID)) {
    return;
  }
  host.registerHealthCheck(createSkillWorkshopToolPolicyCheck(host.explainToolAvailability));
}
