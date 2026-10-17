import {
  getActiveAgentRunDelegatedAuthority,
  getAgentRunContext,
} from "../../infra/agent-run-registry.js";
import {
  ACTIVE_EMBEDDED_RUNS,
  ACTIVE_EMBEDDED_RUNS_BY_RUN_ID,
  ACTIVE_EMBEDDED_RUN_REGISTRATIONS,
} from "./run-state.js";
import { abortEmbeddedAgentRun } from "./runs.js";

/** Follow admitted retries while keeping legacy compaction bound to its exact handle. */
export function prepareEmbeddedAgentRunAbort(sessionId: string) {
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  const registration = handle && ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle);
  const instance = registration?.operationalRunInstance;
  const authority = registration?.delegatedAuthority;
  const agentId = registration?.agentId;
  const sessionKey = registration?.sessionKey;
  const resolveCurrent = () => {
    if (!handle || !registration) {
      return undefined;
    }
    if (!instance || !authority) {
      return ACTIVE_EMBEDDED_RUNS.get(sessionId) === handle &&
        ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle) === registration
        ? registration
        : undefined;
    }
    if (getActiveAgentRunDelegatedAuthority(instance) !== authority) {
      return undefined;
    }
    const successor = ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(instance.runId);
    const current = successor && ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(successor);
    return current &&
      current.operationalRunInstance?.instanceId === instance.instanceId &&
      current.operationalRunInstance.runId === instance.runId &&
      current.delegatedAuthority === authority &&
      current.agentId === agentId &&
      current.sessionKey === sessionKey &&
      ACTIVE_EMBEDDED_RUNS.get(current.sessionId) === successor
      ? current
      : undefined;
  };
  const abort = () => {
    const current = resolveCurrent();
    return current
      ? {
          active: true,
          aborted: abortEmbeddedAgentRun(current.sessionId),
          sessionId: current.sessionId,
        }
      : { active: false, aborted: false };
  };
  return Object.assign(abort, {
    isWaitingForLocalModel: () => {
      const current = resolveCurrent();
      const runId = current && ACTIVE_EMBEDDED_RUNS.get(current.sessionId)?.runId;
      return Boolean(runId && getAgentRunContext(runId)?.localModelWait);
    },
  });
}
