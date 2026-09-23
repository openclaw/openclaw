import { isCronSessionKey, isSubagentSessionKey } from "../sessions/session-key-utils.js";
import { listFinishedSessions, listRunningSessions } from "./bash-process-registry.js";
import { resolveProcessToolScopeKey } from "./bash-process-scope.js";
import { bindRequesterYieldCronAuthority } from "./cron-creator-authority-context.js";
import type { SessionsYieldClaimResult, SessionsYieldIntent } from "./tools/sessions-yield-tool.js";

const ISOLATED_AUTOMATION_YIELD_UNSUPPORTED_ERROR =
  "Isolated automation turns cannot use sessions_yield because no requester continuation is available. Finish this turn so the scheduler can handle child output under the job's delivery policy.";

const SWARM_COLLECTOR_YIELD_UNSUPPORTED_ERROR =
  "Collector runs cannot use sessions_yield because their results are collected explicitly instead of announced. Finish this turn so the collected result is recorded for whoever waits on this run.";

// Apply after inherited policy snapshots: cron's missing continuation is not a child restriction.
export function filterRequesterYieldTools<T extends { name: string }>(
  tools: T[],
  requesterSessionKey: string | undefined,
): T[] {
  return isCronSessionKey(requesterSessionKey)
    ? tools.filter((tool) => tool.name !== "sessions_yield")
    : tools;
}

type YieldCompletionClaim = (
  intent?: SessionsYieldIntent,
) => SessionsYieldClaimResult | Promise<SessionsYieldClaimResult>;

export function createRequesterYieldCallback(params: {
  requesterSessionKey?: string;
  requesterAgentId: string;
  requesterTurnRunId?: string;
  processScopeKey?: string;
  swarmCollector?: boolean;
  claimYieldCompletion?: () => boolean | Promise<boolean>;
}): YieldCompletionClaim | undefined {
  // Requester settlement never resumes cron. Reject before checking claims or writing yield intent.
  if (isCronSessionKey(params.requesterSessionKey)) {
    return () => ({ error: ISOLATED_AUTOMATION_YIELD_UNSUPPORTED_ERROR });
  }
  // A collector result is read by an explicit wait, never delivered by a requester
  // continuation, so a collector yield can only park the run its waiter is blocked
  // on. Reject before any claim source runs so no durable yield intent is recorded.
  if (params.swarmCollector === true) {
    return () => ({ error: SWARM_COLLECTOR_YIELD_UNSUPPORTED_ERROR });
  }
  const canWaitForMessage = isSubagentSessionKey(params.requesterSessionKey);
  const requesterSessionKey = params.requesterSessionKey?.trim() || undefined;
  const hasRegistryClaim = Boolean(requesterSessionKey && params.requesterTurnRunId);
  if (!params.claimYieldCompletion && !canWaitForMessage && !requesterSessionKey) {
    return undefined;
  }
  const withCronAuthority = bindRequesterYieldCronAuthority(params.requesterTurnRunId);
  const processScopeKey = resolveProcessToolScopeKey({
    scopeKey: params.processScopeKey,
    sessionKey: params.requesterSessionKey,
    agentId: params.requesterAgentId,
  });
  return async (intent) => {
    // Runtime claims are observational. Check them before durable registry state
    // so a runtime failure cannot record a yield that never reaches onYield.
    const runtimeClaimed = (await params.claimYieldCompletion?.()) ?? false;
    let registryClaimed = false;
    if (hasRegistryClaim) {
      const { markRequesterTurnYielded } =
        await import("./subagents/registry/subagent-registry.js");
      const markYielded = () =>
        markRequesterTurnYielded({
          requesterSessionKey: params.requesterSessionKey as string,
          requesterAgentId: params.requesterAgentId,
          requesterTurnRunId: params.requesterTurnRunId as string,
        });
      registryClaimed = (withCronAuthority ? withCronAuthority(markYielded) : markYielded()) > 0;
    }
    if (runtimeClaimed || registryClaimed) {
      return true;
    }
    if (canWaitForMessage) {
      // Self-yield can await a user follow-up, but exec completion does not wake
      // subagent sessions. Inspect the current process owner after awaited claims.
      if (
        listRunningSessions().some((session) => session.scopeKey === processScopeKey) ||
        listFinishedSessions().some(
          (session) =>
            session.scopeKey === processScopeKey && session.terminalPollObserved !== true,
        )
      ) {
        return {
          error:
            "Background exec is still running or has an uncollected result in this subagent session. Use process to poll and collect it before yielding; background exec completion cannot resume this subagent, and run-scoped proxy credentials expire when the turn ends.",
        };
      }
      if (intent?.waitFor === "message") {
        return true;
      }
    }
    // This turn owns no claim, but an earlier turn of the same session may still
    // await its children: their completion resumes the session on its own, so
    // report them instead of telling the model the work is finished.
    if (requesterSessionKey) {
      const { listUnsettledRequesterChildren } =
        await import("./subagents/registry/subagent-registry.js");
      const pendingChildren = listUnsettledRequesterChildren({
        requesterSessionKey,
        requesterAgentId: params.requesterAgentId,
        excludeRequesterTurnRunId: params.requesterTurnRunId,
      });
      if (pendingChildren.length > 0) {
        return { pendingChildren };
      }
    }
    return false;
  };
}
