import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { resolveSkillWorkshopToolConstructionBlock } from "./tool-availability.js";

const SKILL_WORKSHOP_TOOL_NAME = "skill_workshop";

/**
 * The host's read-only tool availability explainer: `api.runtime.agent.explainToolAvailability`
 * at runtime, or the one the Doctor bridge passes. Both read the config they are given.
 */
export type ExplainToolAvailability = (
  params: Parameters<PluginRuntime["agent"]["explainToolAvailability"]>[0] & {
    config: OpenClawConfig;
  },
) => ReturnType<PluginRuntime["agent"]["explainToolAvailability"]>;

type SkillWorkshopToolPolicyDiagnostic = {
  agentId: string;
  source: string;
  detail: string;
  fix: string;
  message: string;
};

function explainSkillWorkshopAvailability(
  explainToolAvailability: ExplainToolAvailability,
  config: OpenClawConfig,
  agentId?: string,
) {
  return explainToolAvailability({
    config,
    ...(agentId ? { agentId } : {}),
    toolNames: [SKILL_WORKSHOP_TOOL_NAME],
  });
}

/** True when the agent's tool policy explicitly denies skill_workshop: the agent opted out of Workshop. */
export async function isSkillWorkshopDeniedForAgent(
  explainToolAvailability: ExplainToolAvailability,
  config: OpenClawConfig,
  agentId: string,
): Promise<boolean> {
  const [tool] = (await explainSkillWorkshopAvailability(explainToolAvailability, config, agentId))
    .tools;
  return tool?.available === false && tool.block.stage === "deny";
}

export async function detectSkillWorkshopToolPolicyDiagnostic(params: {
  explainToolAvailability: ExplainToolAvailability;
  config: OpenClawConfig;
  workshopEnabled: boolean;
  agentId?: string;
}): Promise<SkillWorkshopToolPolicyDiagnostic | null> {
  if (!params.workshopEnabled) {
    return null;
  }
  const report = await explainSkillWorkshopAvailability(
    params.explainToolAvailability,
    params.config,
    params.agentId,
  );
  const [tool] = report.tools;
  // A deny is an intentional opt-out, even when a profile excludes the tool first.
  if (tool?.available === false && tool.block.stage === "deny") {
    return null;
  }
  const { agentId, sandbox } = report;
  const prefix = `Skill Workshop is active, but ${JSON.stringify(SKILL_WORKSHOP_TOOL_NAME)} is hidden for agent ${JSON.stringify(agentId)}:`;
  const constructionBlock = resolveSkillWorkshopToolConstructionBlock({
    sandboxed: sandbox.mode !== "off",
  });
  if (constructionBlock) {
    const detail = `${sandbox.source}: ${JSON.stringify(sandbox.mode)}. ${sandbox.mode === "non-main" ? "In non-main sessions, " : ""}${constructionBlock.detail}`;
    return {
      agentId,
      source: sandbox.source,
      detail,
      fix: constructionBlock.fix,
      message: `${prefix} ${detail} ${constructionBlock.fix}`,
    };
  }
  if (!tool || tool.available) {
    return null;
  }
  const { source = tool.block.stage, detail, fix } = tool.block;
  return { agentId, source, detail, fix, message: `${prefix} ${detail} ${fix}` };
}
