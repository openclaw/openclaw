import { isCronSessionKey, isSubagentSessionKey } from "../sessions/session-key-utils.js";

const ISOLATED_AUTOMATION_YIELD_UNSUPPORTED_ERROR =
  "Isolated automation turns cannot use sessions_yield because no requester continuation is available. Finish this turn so the scheduler can handle child output under the job's delivery policy.";

// Apply after inherited policy snapshots: cron's missing continuation is not a child restriction.
export function filterRequesterYieldTools<T extends { name: string }>(
  tools: T[],
  requesterSessionKey: string | undefined,
): T[] {
  return isCronSessionKey(requesterSessionKey)
    ? tools.filter((tool) => tool.name !== "sessions_yield")
    : tools;
}

type YieldCompletionClaim = () =>
  | boolean
  | { error: string }
  | Promise<boolean | { error: string }>;

export function createRequesterYieldCallback(params: {
  requesterSessionKey?: string;
  requesterAgentId: string;
  requesterTurnRunId?: string;
  claimYieldCompletion?: () => boolean | Promise<boolean>;
}): YieldCompletionClaim | undefined {
  // Requester settlement never resumes cron. Reject before checking claims or writing yield intent.
  if (isCronSessionKey(params.requesterSessionKey)) {
    return () => ({ error: ISOLATED_AUTOMATION_YIELD_UNSUPPORTED_ERROR });
  }
  const selfClaimed = isSubagentSessionKey(params.requesterSessionKey);
  const hasRegistryClaim = Boolean(params.requesterSessionKey && params.requesterTurnRunId);
  if (!params.claimYieldCompletion && !selfClaimed && !hasRegistryClaim) {
    return undefined;
  }
  return async () => {
    // Runtime claims are observational. Check them before durable registry state
    // so a runtime failure cannot record a yield that never reaches onYield.
    const runtimeClaimed = (await params.claimYieldCompletion?.()) ?? false;
    if (!hasRegistryClaim) {
      return runtimeClaimed || selfClaimed;
    }
    const { markRequesterTurnYielded } = await import("./subagents/registry/subagent-registry.js");
    const registryClaimed =
      markRequesterTurnYielded({
        requesterSessionKey: params.requesterSessionKey as string,
        requesterAgentId: params.requesterAgentId,
        requesterTurnRunId: params.requesterTurnRunId as string,
      }) > 0;
    return runtimeClaimed || selfClaimed || registryClaimed;
  };
}
