import { listAgentIds } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { HealthCheck, HealthFinding } from "openclaw/plugin-sdk/health";
import { resolveSkillWorkshopConfig } from "./src/config.js";
import {
  detectSkillWorkshopToolPolicyDiagnostic,
  type ExplainToolAvailability,
} from "./src/tool-policy-diagnostic.js";

// Light Doctor artifact: core loads it through the bundled health-check bridge even while the
// plugin is disabled, so it can report that the plugin itself is switched off.
const SKILL_WORKSHOP_TOOL_POLICY_CHECK_ID = "skill-workshop/tool-policy";

/** Skill Workshop needs its review tool and the skill-workshop plugin that loads learned skills. */
function createSkillWorkshopToolPolicyCheck(
  explainToolAvailability: ExplainToolAvailability,
): HealthCheck {
  return {
    id: SKILL_WORKSHOP_TOOL_POLICY_CHECK_ID,
    kind: "plugin",
    source: "skill-workshop",
    description: "Autonomous Skill Workshop capture has a callable review tool.",
    async detect(ctx) {
      const workshopEnabled = resolveSkillWorkshopConfig(ctx.cfg).autonomous.mode !== "off";
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
      // Learned skills load through the skill-workshop plugin; these switches keep it off.
      const plugins = ctx.cfg.plugins;
      const allowlistExcludes =
        Array.isArray(plugins?.allow) &&
        plugins.allow.length > 0 &&
        !plugins.allow.some((id) => id.trim().toLowerCase() === "skill-workshop");
      const pluginOff = workshopEnabled && (plugins?.enabled === false || allowlistExcludes);
      const pluginFinding: HealthFinding[] = pluginOff
        ? [
            {
              checkId: SKILL_WORKSHOP_TOOL_POLICY_CHECK_ID,
              category: "fix-now",
              docsUrl: "https://docs.openclaw.ai/tools/skill-workshop",
              severity: "warning",
              message: `Skill Workshop is on, but ${plugins?.enabled === false ? "plugins.enabled=false" : "plugins.allow"} keeps the skill-workshop plugin off, so learned skills are not loaded.`,
              path: plugins?.enabled === false ? "plugins.enabled" : "plugins.allow",
              requirement: "Learned skills load through the skill-workshop plugin.",
              fixHint:
                plugins?.enabled === false
                  ? "Enable plugins and limit them with plugins.allow, including skill-workshop."
                  : 'Add "skill-workshop" to plugins.allow.',
            },
          ]
        : [];
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
      return [...pluginFinding, ...policyFindings];
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
