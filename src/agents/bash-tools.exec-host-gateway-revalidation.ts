// Spawn-boundary recheck of skill-bin authority for gateway-host exec, turned into the denial the
// launch reports instead of spawning. Approval-binding drift stays with
// bash-tools.exec-approval-binding.
import type {
  ExecAllowlistEntry,
  ExecCommandSegment,
  ExecSegmentSatisfiedBy,
} from "../infra/exec-approvals.js";
import {
  evaluateGatewayShellAllowlist,
  findRevokedGatewaySkillBinSegment,
} from "./bash-tools.exec-host-gateway-allowlist.js";
import { buildGatewayExecApprovalDeniedToolResult } from "./bash-tools.exec-host-gateway.output.js";
import type { ProcessGatewayAllowlistParams } from "./bash-tools.exec-host-gateway.types.js";
import type { ExecToolDetails } from "./bash-tools.exec-result.types.js";
import type { AgentToolResult } from "./runtime/index.js";

const SKILL_BIN_AUTHORITY_REVOKED_DENIED_MESSAGE =
  "SYSTEM_RUN_DENIED: skill bin authorization changed before execution";

/** Runs spawn-boundary rechecks in order and returns the first denial. */
export function chainRevalidations(
  revalidations: Array<(() => Promise<AgentToolResult<ExecToolDetails> | undefined>) | undefined>,
): (() => Promise<AgentToolResult<ExecToolDetails> | undefined>) | undefined {
  const active = revalidations.filter(
    (revalidate): revalidate is () => Promise<AgentToolResult<ExecToolDetails> | undefined> =>
      Boolean(revalidate),
  );
  if (active.length === 0) {
    return undefined;
  }
  return async () => {
    for (const revalidate of active) {
      const denied = await revalidate();
      if (denied) {
        return denied;
      }
    }
    return undefined;
  };
}

/**
 * Spawn-boundary recheck of skill-bin authority. The approvals file records the autoAllowSkills
 * flag but never the executable a skill authorized, so the committed-policy recheck cannot see
 * that binary change while approval settles; this re-resolves the authorizing skill bins when the
 * launch starts. Authority is checked once at that point: a skill change after it applies to the
 * next request. Both members are undefined when no segment was admitted on skill trust.
 */
function createGatewaySkillBinAuthorityRecheck(params: {
  allowlistParams: ProcessGatewayAllowlistParams;
  analysisOk: boolean;
  segments: readonly ExecCommandSegment[];
  segmentSatisfiedBy: readonly ExecSegmentSatisfiedBy[];
  autoAllowSkills: boolean;
}) {
  // Only a command that analyzed cleanly can have segments admitted on skill trust.
  if (!params.analysisOk || !params.segmentSatisfiedBy.includes("skills")) {
    return { resolveSkillBinAuthorityDrift: undefined, revalidateSkillBinAuthority: undefined };
  }
  const resolveSkillBinAuthorityDrift = async (): Promise<string | undefined> =>
    (await findRevokedGatewaySkillBinSegment(params))
      ? SKILL_BIN_AUTHORITY_REVOKED_DENIED_MESSAGE
      : undefined;
  const revalidateSkillBinAuthority = async (): Promise<
    AgentToolResult<ExecToolDetails> | undefined
  > =>
    (await resolveSkillBinAuthorityDrift())
      ? buildGatewayExecApprovalDeniedToolResult({
          deniedReason: SKILL_BIN_AUTHORITY_REVOKED_DENIED_MESSAGE,
          command: params.allowlistParams.command,
          cwd: params.allowlistParams.workdir,
        })
      : undefined;
  return { resolveSkillBinAuthorityDrift, revalidateSkillBinAuthority };
}

/** Evaluates the gateway allowlist and prepares the authority recheck for its skill-trusted segments. */
export async function evaluateGatewayShellAllowlistWithSkillAuthority(
  params: ProcessGatewayAllowlistParams,
  allowlist: ExecAllowlistEntry[],
  autoAllowSkills: boolean,
) {
  const allowlistEval = await evaluateGatewayShellAllowlist(params, allowlist, autoAllowSkills);
  const skillAuthority = createGatewaySkillBinAuthorityRecheck({
    allowlistParams: params,
    analysisOk: allowlistEval.analysisOk,
    segments: allowlistEval.segments,
    segmentSatisfiedBy: allowlistEval.segmentSatisfiedBy,
    autoAllowSkills,
  });
  return { allowlistEval, skillAuthority };
}
