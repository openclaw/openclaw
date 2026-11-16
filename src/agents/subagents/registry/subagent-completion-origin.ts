import { isDeepStrictEqual } from "node:util";
import { readSessionEntryReadOnlyInWorker } from "../../../config/sessions/session-entry-read-runtime.js";
import { captureQueuedOperatorRecoverySource } from "../../../gateway/operator-run-recovery-source.js";
import {
  authorizeTurn,
  TurnWithheldError,
  withheldOnRefusal,
} from "../../../gateway/operator-run-recovery.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import {
  captureOperatorToolGatewayContinuationContext,
  withOperatorToolGatewayAuthority,
} from "../../../gateway/server-plugin-in-process-dispatch.js";
import { prepareSessionPrincipalRunAuthority } from "../../../gateway/session-sharing-authorization-async.js";
import {
  getGatewayContextResolver,
  withPluginRuntimeGatewayContextResolver,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { SubagentAnnouncePreparationConflictError } from "../announce/subagent-announce-result.js";
import { resolveRecordedRequester } from "./subagent-child-owner-match.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import type { SubagentOriginFacts, SubagentRunRecord } from "./subagent-registry.types.js";

export function captureSubagentOriginFacts(
  continuation: Awaited<ReturnType<typeof captureOperatorToolGatewayContinuationContext>>,
): SubagentOriginFacts {
  if (!continuation) {
    return { kind: "none" };
  }
  const authority = continuation.operatorAuthority;
  if (!authority) {
    return { kind: "system", scopes: [...(continuation.scopes ?? [])] };
  }
  const facts = captureQueuedOperatorRecoverySource(authority) ?? { kind: "unavailable" };
  // The child gets exactly the session principal its spawning turn ran as.
  return facts.kind === "unavailable" && authority.sessionPrincipalProfileId
    ? { kind: "session", profileId: authority.sessionPrincipalProfileId }
    : facts;
}

/**
 * A completion runs under its saved origin facts and current policy, never a live closure.
 * A Gateway row without facts was written by an older build: it is withheld, never widened.
 */
export async function runWithSubagentOrigin<T>(
  entry: SubagentRunRecord,
  run: () => Promise<T>,
): Promise<T> {
  const resolver = getGatewayContextResolver(entry);
  const context = resolver?.();
  const facts = entry.originFacts;
  if (facts?.kind === "none" || (!context && !facts)) {
    return await run();
  }
  if (!context) {
    throw new Error("Subagent completion origin needs a running Gateway");
  }
  if (!facts) {
    throw new TurnWithheldError("the origin of this child run was not saved");
  }
  // A temporary restore outage keeps the result pending for the preparation retry path.
  const restored = await (
    facts.kind === "system"
      ? Promise.resolve(undefined)
      : facts.kind === "session"
        ? restoreSessionPrincipal(entry, facts.profileId, context)
        : authorizeTurn({ facts, context })
  ).catch((error: unknown) => {
    throw error instanceof TurnWithheldError
      ? error
      : new SubagentAnnouncePreparationConflictError("Subagent completion origin is unavailable", {
          cause: error,
        });
  });
  try {
    // Delivery never inherits the ambient caller's request scope or client.
    return await withPluginRuntimeGatewayContextResolver(
      resolver,
      () =>
        withOperatorToolGatewayAuthority(
          {
            operatorRunAuthority: restored?.authority,
            operatorRoleActor: { kind: "system" },
            scopes: [
              ...(restored?.authority.scopes ?? (facts.kind === "system" ? facts.scopes : [])),
            ],
          },
          async () => {
            const continuation = await captureOperatorToolGatewayContinuationContext();
            if (!continuation) {
              throw new Error("Subagent completion has no current Gateway authority");
            }
            try {
              return await continuation.run(run);
            } finally {
              continuation.release();
            }
          },
        ),
      { inheritRequestScope: false },
    );
  } finally {
    restored?.release();
  }
}

export function runWithCompletionOrigin<T>(entry: SubagentRunRecord, run: () => Promise<T>) {
  return runWithCompletionBatchOrigin([entry], run);
}

/** One cohort shares one origin; a cancellation notice without facts keeps its caller. */
export async function runWithCompletionBatchOrigin<T>(
  observed: readonly SubagentRunRecord[],
  run: () => Promise<T>,
): Promise<T> {
  const batch = subagentRuns.currentCompletionBatch(observed);
  const notice = (entry: SubagentRunRecord) =>
    entry.endedReason === SUBAGENT_ENDED_REASON_KILLED &&
    entry.execution.outcome?.status === "error";
  const owner = batch.find((entry) => !notice(entry) || entry.originFacts);
  if (!owner) {
    return await run();
  }
  if (
    batch.some(
      (entry) =>
        (entry.originFacts || !notice(entry)) &&
        !isDeepStrictEqual(entry.originFacts, owner.originFacts),
    )
  ) {
    throw new Error("Subagent completion batch has incompatible operator authority");
  }
  return await runWithSubagentOrigin(owner, run);
}

/** The saved profile must still hold its access to the requester chat; otherwise it is withheld. */
async function restoreSessionPrincipal(
  entry: SubagentRunRecord,
  profileId: string,
  context: GatewayRequestContext,
) {
  const scope = {
    agentId: resolveRecordedRequester(entry) ?? "",
    sessionKey: entry.requesterSessionKey,
    storePath: entry.requesterStorePath,
  };
  return await withheldOnRefusal(async () => {
    const requester = await readSessionEntryReadOnlyInWorker(scope);
    if (!requester?.sessionId) {
      throw new TurnWithheldError("the requester chat is gone");
    }
    return await prepareSessionPrincipalRunAuthority({
      context,
      ...scope,
      profileId,
      sessionId: requester.sessionId,
      sessionPrincipal: true,
    });
  });
}
