import path from "node:path";
import {
  evaluateExecAllowlist,
  type ExecAllowlistAnalysis,
  type ExecSegmentSatisfiedBy,
} from "../infra/exec-approvals-allowlist.js";
import type { ExecAllowlistEntry } from "../infra/exec-approvals.js";
import { analyzeArgvCommand } from "../infra/exec-argv-analysis.js";
import type { ExecAuthorizationPlan } from "../infra/exec-authorization-plan.js";
import { buildAuthorizedShellCommandFromPlan } from "../infra/exec-authorization-render.js";
import { resolveUnpinnedAutoApprovalEligibility } from "../infra/exec-auto-approval-eligibility.js";
import { resolveExecWrapperTrustPlan } from "../infra/exec-wrapper-trust-plan.js";
import { buildNodeShellCommand } from "../infra/node-shell.js";

// Mirrors the node's shell-free branch of evaluateSystemRunAllowlist: analyze the argv, then
// evaluate it with evaluateExecAllowlist. The node takes platform and env from its own
// process; the Gateway passes the node's platform and a PATH-less env so its own host
// never leaks into the decision. Safe bins and skill bins are node-local, so the precheck
// grants nothing through them and can only be stricter than the node.
export async function evaluateNodeDirectArgvAllowlist(params: {
  argv: string[];
  allowlist: ExecAllowlistEntry[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  platform?: string | null;
  trustedSafeBinDirs?: ReadonlySet<string>;
}): Promise<ExecAllowlistAnalysis> {
  const analysis = analyzeArgvCommand({
    argv: params.argv,
    cwd: params.cwd,
    env: params.env,
    platform: params.platform,
  });
  return {
    ...evaluateExecAllowlist({
      analysis,
      allowlist: params.allowlist,
      safeBins: new Set(),
      cwd: params.cwd,
      env: params.env,
      platform: params.platform,
      trustedSafeBinDirs: params.trustedSafeBinDirs,
    }),
    analysisOk: analysis.ok,
    segments: analysis.segments,
  };
}

export function resolveNodeAutoApprovalEligibility(params: {
  argv: string[];
  shellPayload: string | null;
  platform?: string | null;
  authorizationPlan: ExecAuthorizationPlan | undefined;
  segmentSatisfiedBy: ExecSegmentSatisfiedBy[];
}): ReturnType<typeof resolveUnpinnedAutoApprovalEligibility> {
  const platform =
    params.platform === "win32" ? "win32" : params.platform === "darwin" ? "darwin" : "linux";
  const preparedTrustPlan = resolveExecWrapperTrustPlan(params.argv, undefined, platform);
  const pinnedDirectCommand =
    params.shellPayload === null &&
    preparedTrustPlan.dispatchChain?.length === 1 &&
    (platform === "win32" ? path.win32 : path.posix).isAbsolute(params.argv[0] ?? "");
  const expectedTransport = params.shellPayload
    ? buildNodeShellCommand(params.shellPayload, params.platform)
    : undefined;
  const payloadPlan = params.authorizationPlan;
  const payloadCandidates = payloadPlan?.ok
    ? payloadPlan.groups.flatMap((group) => group.candidates)
    : [];
  const payloadSegment = payloadCandidates[0]?.sourceSegment;
  const pinnedTransportCommand =
    expectedTransport !== undefined &&
    expectedTransport.length === params.argv.length &&
    expectedTransport.every((arg, index) => arg === params.argv[index]) &&
    payloadCandidates.length === 1 &&
    payloadCandidates[0]?.transport.kind === "direct" &&
    payloadCandidates[0]?.trustMode === "executable" &&
    payloadSegment !== undefined &&
    resolveExecWrapperTrustPlan(
      payloadSegment.sourceArgv ?? payloadSegment.argv,
      undefined,
      platform,
    ).dispatchChain?.length === 1 &&
    (platform === "win32" ? path.win32 : path.posix).isAbsolute(payloadSegment.argv[0] ?? "") &&
    payloadPlan !== undefined &&
    buildAuthorizedShellCommandFromPlan({
      plan: payloadPlan,
      mode: "enforced",
      segmentSatisfiedBy: params.segmentSatisfiedBy,
    }).ok;
  // The canonical node shell carries an already-absolute direct command. Its
  // payload still must exclude expansions and user-controlled dispatch wrappers.
  return pinnedDirectCommand || pinnedTransportCommand
    ? { eligible: true as const }
    : resolveUnpinnedAutoApprovalEligibility({
        authorizationPlan: params.authorizationPlan,
        binding: undefined,
        platform,
      });
}
