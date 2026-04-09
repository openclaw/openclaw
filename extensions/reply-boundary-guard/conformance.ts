import {
  buildReplyBoundaryConformanceContract,
  buildReplyBoundaryEnforcementDecision,
  classifyReplyBoundaryClaimFamilies,
  evaluateReplyBoundaryPolicy,
  getReplyBoundaryContractMetadata,
  inferReplyBoundaryWaitingOn,
  rewriteReplyBoundaryText,
  runReplyBoundaryConformanceSuite,
  suggestReplyBoundaryRewrite,
} from "../../../moonlight/src/pinocchio/reply-boundary/index.ts";

export const REPLY_BOUNDARY_GUARD_CONSUMER = "reply-boundary-guard";

export function getReplyBoundaryGuardConsumedContractMetadata() {
  return getReplyBoundaryContractMetadata();
}

export function buildReplyBoundaryGuardConformanceContract() {
  return buildReplyBoundaryConformanceContract({
    classifyReplyBoundaryClaimFamilies,
    evaluateReplyBoundaryPolicy,
    suggestReplyBoundaryRewrite,
    rewriteReplyBoundaryText,
    buildReplyBoundaryEnforcementDecision,
    inferReplyBoundaryWaitingOn,
  });
}

export function runReplyBoundaryGuardConformanceSuite() {
  return runReplyBoundaryConformanceSuite(buildReplyBoundaryGuardConformanceContract());
}
