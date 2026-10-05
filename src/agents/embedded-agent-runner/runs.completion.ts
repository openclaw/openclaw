import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../../infra/agent-events.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  ACTIVE_EMBEDDED_RUNS,
  ACTIVE_EMBEDDED_RUN_REGISTRATIONS,
  EMBEDDED_RUN_COMPLETION_CLAIMS,
  type EmbeddedRunCompletionClaim,
  type EmbeddedRunCompletionRegistration,
  type EmbeddedRunRegistration,
} from "./run-state.js";

export function revokeCompletionClaim(sessionId: string, runId?: string): void {
  const claim = EMBEDDED_RUN_COMPLETION_CLAIMS.get(sessionId);
  if (claim && (runId === undefined || claim.runId === runId)) {
    claim.settleRegistration(undefined);
    EMBEDDED_RUN_COMPLETION_CLAIMS.delete(sessionId);
  }
}

export function prepareEmbeddedAgentRunCompletionClaim(
  sessionId: string,
  runId: string,
): {
  bindOperationalRunInstance: (
    instance: NonNullable<EmbeddedRunRegistration["operationalRunInstance"]>,
  ) => boolean;
  claimCompletion: () => boolean;
  claimFailure: () => boolean;
  resolveCurrentRegistration: () => EmbeddedRunCompletionRegistration | undefined;
  registered: Promise<EmbeddedRunCompletionRegistration | undefined>;
} {
  const { promise: registered, resolve: settleRegistration } = createDeferredCore<
    EmbeddedRunCompletionRegistration | undefined
  >();
  const claim: EmbeddedRunCompletionClaim = {
    runId,
    lifecycleGeneration: getAgentEventLifecycleGeneration(),
    promoted: false,
    settleRegistration,
  };
  revokeCompletionClaim(sessionId);
  EMBEDDED_RUN_COMPLETION_CLAIMS.set(sessionId, claim);
  const consume = (allowUnregistered: boolean): boolean => {
    if (EMBEDDED_RUN_COMPLETION_CLAIMS.get(sessionId) !== claim) {
      return false;
    }
    EMBEDDED_RUN_COMPLETION_CLAIMS.delete(sessionId);
    if (!claim.promoted) {
      claim.settleRegistration(undefined);
    }
    return (
      (allowUnregistered || claim.promoted) &&
      isAgentEventLifecycleGenerationCurrent(claim.lifecycleGeneration)
    );
  };
  const bindOperationalRunInstance = (
    instance: NonNullable<EmbeddedRunRegistration["operationalRunInstance"]>,
  ): boolean => {
    if (
      EMBEDDED_RUN_COMPLETION_CLAIMS.get(sessionId) !== claim ||
      !isAgentEventLifecycleGenerationCurrent(claim.lifecycleGeneration) ||
      instance.runId !== runId ||
      (claim.operationalRunInstance !== undefined && claim.operationalRunInstance !== instance)
    ) {
      return false;
    }
    claim.operationalRunInstance = instance;
    return true;
  };
  const resolveCurrentRegistration = (): EmbeddedRunCompletionRegistration | undefined => {
    const stale = () => new Error("The active agent run backend is no longer current");
    if (
      EMBEDDED_RUN_COMPLETION_CLAIMS.get(sessionId) !== claim ||
      !isAgentEventLifecycleGenerationCurrent(claim.lifecycleGeneration)
    ) {
      throw stale();
    }
    const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
    const registration = handle ? ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle) : undefined;
    if (!handle) {
      return undefined;
    }
    if (
      handle.runId !== runId ||
      !claim.operationalRunInstance ||
      registration?.operationalRunInstance !== claim.operationalRunInstance
    ) {
      throw stale();
    }
    // Missing steering authority is recoverable only for this exact live admission.
    // A revoked claim must never authorize a caller's cancel-and-replace fallback.
    const toolAuthority = registration.toolAuthority;
    if (!toolAuthority) {
      return undefined;
    }
    try {
      toolAuthority.assertActive();
    } catch {
      throw stale();
    }
    if (
      EMBEDDED_RUN_COMPLETION_CLAIMS.get(sessionId) !== claim ||
      ACTIVE_EMBEDDED_RUNS.get(sessionId) !== handle ||
      ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle) !== registration ||
      !isAgentEventLifecycleGenerationCurrent(claim.lifecycleGeneration)
    ) {
      throw stale();
    }
    return { toolAuthority };
  };
  return {
    bindOperationalRunInstance,
    claimCompletion: () => consume(false),
    claimFailure: () => consume(true),
    resolveCurrentRegistration,
    registered,
  };
}
