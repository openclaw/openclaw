/**
 * Gateway-host exec allowlist evaluation, including skill bins for autoAllowSkills.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  evaluateShellAllowlistWithAuthorization,
  type ExecAllowlistEntry,
  type SkillBinTrustEntry,
} from "../infra/exec-approvals.js";
import { resolveSkillBinTrustEntries } from "../node-host/runtime-skill-bins.js";
import { collectSkillBins } from "../skills/discovery/bins.js";
import { resolveWorkspaceSkillPromptEntries } from "../skills/loading/workspace-skill-loader.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "./agent-scope-config.js";
import type { ProcessGatewayAllowlistParams } from "./bash-tools.exec-host-gateway.types.js";

/**
 * Skill bins for gateway-host autoAllowSkills: only the executing agent's eligible skills (the set
 * its prompt sees: enabled, allowed, requirements met), never every installed skill, resolved on the
 * PATH the command itself resolves on, as the node host resolves `skills.bins`. That PATH is the
 * Gateway's plus operator `pathPrepend`: host exec rejects a requested PATH, so a tool call cannot
 * point a skill bin name at another binary. Fails closed to no bins.
 */
async function resolveGatewaySkillBins(params: {
  config?: OpenClawConfig;
  agentId?: string;
  env: Record<string, string>;
}): Promise<SkillBinTrustEntry[]> {
  if (!params.config) {
    return [];
  }
  try {
    const agentId = params.agentId ?? resolveDefaultAgentId(params.config);
    const { eligible } = await resolveWorkspaceSkillPromptEntries(
      resolveAgentWorkspaceDir(params.config, agentId),
      { config: params.config, agentId },
    );
    return resolveSkillBinTrustEntries(
      collectSkillBins(eligible),
      params.env.PATH ?? process.env.PATH ?? "",
    );
  } catch {
    return [];
  }
}

/** Evaluates a gateway-host command against the approvals allowlist, safe bins and skill bins. */
export async function evaluateGatewayShellAllowlist(
  params: ProcessGatewayAllowlistParams,
  allowlist: ExecAllowlistEntry[],
  autoAllowSkills: boolean,
) {
  const skillBins = autoAllowSkills
    ? await resolveGatewaySkillBins({
        config: params.config,
        agentId: params.agentId,
        env: params.env,
      })
    : [];
  return evaluateShellAllowlistWithAuthorization({
    command: params.command,
    allowlist,
    safeBins: params.safeBins,
    safeBinProfiles: params.safeBinProfiles,
    cwd: params.workdir,
    env: params.env,
    platform: process.platform,
    trustedSafeBinDirs: params.trustedSafeBinDirs,
    skillBins,
    autoAllowSkills,
  });
}
