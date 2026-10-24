import {
  clearGatewayContextResolver,
  getGatewayContextResolver,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { captureSessionTarget } from "../../../sessions/session-controller.lifecycle.js";
import {
  getRpcSourceForGateway,
  getRpcSourceIdentity,
  getRpcSourceLifecycleGeneration,
  type RpcSourceRef,
} from "../../../sessions/session-controller.rpc-sources.js";
import { sessionTargetOwnersMatch } from "../../../sessions/session-controller.target.js";
import { resolveActiveEmbeddedRunOwnerByRunId } from "../../embedded-agent-runner/runs.js";
import { retireRequesterFollowupAuthority } from "../requester-cron-authority.js";
import { resolveSubagentChildAuthority } from "./subagent-child-owner-match.js";
import type { SubagentKillSession } from "./subagent-control-session.js";
import { getCurrentSubagentRunOwner, subagentRuns } from "./subagent-registry-memory.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { getSubagentRunRuntimeKey } from "./subagent-run-generation.js";

// A retired row retains only its exact source reference; the controller owns cleanup.
// Empty weak slots prevent that runtime incarnation from adopting a replacement.
const retiredExecutions = new WeakMap<object, RpcSourceRef | undefined>();

export type CapturedSubagentExecution = {
  readonly entry: SubagentRunRecord;
  readonly runId: string;
  readonly execution: RpcSourceRef;
};

/** Captures the exact physical backend of a legacy row, not a replacement session. */
export function captureSubagentEmbeddedExecution(entry: SubagentRunRecord) {
  if (resolveSubagentChildAuthority(entry).status === "mismatch") {
    return undefined;
  }
  const owner = resolveActiveEmbeddedRunOwnerByRunId(entry.runId);
  return owner?.sessionKey === entry.childSessionKey &&
    (!entry.childSessionIdentity?.sessionId ||
      owner.sessionId === entry.childSessionIdentity.sessionId)
    ? owner
    : undefined;
}

/** Captures the exact controller source owned by the selected subagent run. */
export function captureSubagentExecution(params: {
  entry: SubagentRunRecord;
  session: Pick<SubagentKillSession, "agentId" | "storePath" | "entry">;
}): CapturedSubagentExecution | undefined {
  const entry = getCurrentSubagentRunOwner(subagentRuns, params.entry) ?? params.entry;
  const authority = resolveSubagentChildAuthority(entry);
  if (authority.status === "mismatch") {
    return undefined;
  }
  const target = captureSessionTarget({
    storeScope: params.session.storePath,
    sessionKey: entry.childSessionKey,
    agentId: params.session.agentId,
    incarnation:
      authority.status === "legacy-unverified"
        ? entry.childSessionIdentity?.sessionId
        : params.session.entry?.sessionId,
  });
  const runtimeKey = getSubagentRunRuntimeKey(entry);
  const retiredExecution = retiredExecutions.get(runtimeKey);
  const execution = retiredExecutions.has(runtimeKey)
    ? retiredExecution
    : getRpcSourceForGateway(entry.runId, getGatewayContextResolver(entry), target);
  const retiredTarget = retiredExecution?.input.mailbox.owner.target;
  if (
    !execution ||
    execution.adapter.kind !== "agent" ||
    (retiredTarget && !sessionTargetOwnersMatch(retiredTarget, target))
  ) {
    return undefined;
  }
  const identity = getRpcSourceIdentity(execution);
  const lifecycleGeneration = getRpcSourceLifecycleGeneration(execution);
  if (
    identity.sessionKey !== entry.childSessionKey ||
    identity.agentId !== authority.childAgentId ||
    entry.childSessionIdentity?.lifecycleRevision !== params.session.entry?.lifecycleRevision ||
    (authority.status === "legacy-unverified"
      ? entry.childSessionIdentity?.sessionId !== undefined &&
        identity.sessionId !== entry.childSessionIdentity.sessionId
      : identity.sessionId !== params.session.entry?.sessionId) ||
    (entry.execution.lifecycleGeneration !== undefined &&
      lifecycleGeneration !== entry.execution.lifecycleGeneration)
  ) {
    return undefined;
  }
  return { entry, runId: entry.runId, execution };
}

/** Retires the registry projection; controller source settlement retains physical cleanup. */
export function retireSubagentGatewayBinding(observed: SubagentRunRecord): void {
  const entry = getCurrentSubagentRunOwner(subagentRuns, observed) ?? observed;
  retireRequesterFollowupAuthority(entry);
  const runtimeKey = getSubagentRunRuntimeKey(entry);
  if (!retiredExecutions.has(runtimeKey)) {
    const execution = getRpcSourceForGateway(entry.runId, getGatewayContextResolver(entry));
    retiredExecutions.set(runtimeKey, execution);
    if (execution) {
      const release = () => {
        retiredExecutions.set(runtimeKey, undefined);
      };
      void execution.input.settlement.promise.then(release, release);
    }
  }
  clearGatewayContextResolver(entry);
}
