/**
 * Gateway-host exec allowlist evaluation, including skill bins for autoAllowSkills.
 */
import {
  evaluateShellAllowlistWithAuthorization,
  isSegmentAuthorizedBySkillBins,
  type ExecAllowlistEntry,
  type ExecCommandSegment,
  type ExecSegmentSatisfiedBy,
  type SkillBinTrustEntry,
} from "../infra/exec-approvals.js";
import { resolveSkillBinTrustEntries } from "../node-host/runtime-skill-bins.js";
import { collectSkillBins } from "../skills/discovery/bins.js";
import { resolveWorkspaceSkillPromptEntries } from "../skills/loading/workspace-skill-loader.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "./agent-scope-config.js";
import type { ProcessGatewayAllowlistParams } from "./bash-tools.exec-host-gateway.types.js";

/**
 * Skill bins for gateway-host autoAllowSkills: only the skills eligible for the admitted run (the
 * set its prompt sees: enabled, allowed, requirements met, then narrowed by the session's own skill
 * filter and overrides), never every installed skill, resolved on the PATH the command itself
 * resolves on, as the node host resolves `skills.bins`. That PATH is the Gateway's plus operator
 * `pathPrepend`: host exec rejects a requested PATH, so a tool call cannot point a skill bin name at
 * another binary. A session that excludes a skill therefore cannot borrow its binaries. The skills
 * are the executing agent's (`skillScope.ownerAgentId`), the agent the run's skill scope was
 * admitted for: a run that borrows another agent's tool policy takes that agent's approvals, never
 * its skills. Fails closed to no bins.
 */
async function resolveGatewaySkillBins(
  params: Pick<ProcessGatewayAllowlistParams, "config" | "agentId" | "skillScope" | "env">,
): Promise<SkillBinTrustEntry[]> {
  const pathEnv = params.env.PATH ?? process.env.PATH ?? "";
  if (!params.config) {
    return [];
  }
  try {
    const agentId =
      params.skillScope?.ownerAgentId ?? params.agentId ?? resolveDefaultAgentId(params.config);
    const workspaceDir = resolveAgentWorkspaceDir(params.config, agentId);
    const { eligible } = await resolveWorkspaceSkillPromptEntries(workspaceDir, {
      config: params.config,
      agentId,
      // The run's admitted scope, not a fresh agent-config-only projection: the session's
      // filter and overrides must bound which skills can authorize a host binary.
      ...(params.skillScope?.skillFilter ? { skillFilter: params.skillScope.skillFilter } : {}),
      ...(params.skillScope?.skillOverrides
        ? { skillOverrides: params.skillScope.skillOverrides }
        : {}),
    });
    return await resolveSkillBinTrustEntries(collectSkillBins(eligible), pathEnv);
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
  const skillBins = autoAllowSkills ? await resolveGatewaySkillBins(params) : [];
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

type GatewaySkillBinSegments = {
  segments: readonly ExecCommandSegment[];
  segmentSatisfiedBy: readonly ExecSegmentSatisfiedBy[];
};

/**
 * Re-resolves skill-bin authority when an admitted launch starts and reports the first segment that
 * skill trust no longer covers. The approvals file records only the `autoAllowSkills` flag, never
 * which skill or executable authorized the command, so the committed `requireAutoAllowSkills`
 * recheck cannot see the trusted name being repointed at a different executable while approval
 * settles. Fails closed: a scope that no longer resolves yields no bins, which denies.
 */
export async function findRevokedGatewaySkillBinSegment(
  params: GatewaySkillBinSegments & {
    allowlistParams: ProcessGatewayAllowlistParams;
    autoAllowSkills: boolean;
  },
): Promise<ExecCommandSegment | undefined> {
  const skillSegments = params.segments.filter(
    (_segment, index) => params.segmentSatisfiedBy[index] === "skills",
  );
  if (skillSegments.length === 0) {
    return undefined;
  }
  if (!params.autoAllowSkills) {
    return skillSegments[0];
  }
  const skillBins = await resolveGatewaySkillBins(params.allowlistParams);
  for (const segment of skillSegments) {
    if (!(await isSegmentAuthorizedBySkillBins({ segment, skillBins }))) {
      return segment;
    }
  }
  return undefined;
}
