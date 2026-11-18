import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../../infra/agent-events.js";
import {
  getAgentRunContext,
  validateAgentRunDelegatedAuthority,
  type AgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import {
  getSessionControllerOperation,
  isCurrentSessionControllerOperation,
} from "../../sessions/session-controller.state.js";
import type { SessionTarget } from "../../sessions/session-controller.target.js";
import { getControllerEmbeddedAttachment } from "./run-state.js";
import { withAuthorizedPermissionChange } from "./run/permission-change.js";

/** Captures one exact live runtime; a later run must never inherit this update. */
export function prepareEmbeddedRunPermissionChange(target: SessionTarget) {
  const operation = getSessionControllerOperation(target.sessionKey, target);
  if (!operation || operation.result) {
    return { kind: "idle" as const };
  }
  const currentHandle = () =>
    isCurrentSessionControllerOperation(operation)
      ? getControllerEmbeddedAttachment(operation)?.handle
      : undefined;
  const handle = currentHandle();
  if (!handle?.applyPermissionMode) {
    return { kind: "unsupported" as const };
  }
  const applyPermissionMode = handle.applyPermissionMode;
  const generation = getAgentEventLifecycleGeneration();
  const owner = handle.permissionChangeOwner;
  const authority = handle.runId ? getAgentRunContext(handle.runId)?.delegatedAuthority : undefined;
  const ownsRuntime = () => {
    const current = currentHandle();
    return (
      isAgentEventLifecycleGenerationCurrent(generation) &&
      !operation.result &&
      (current === handle || (owner !== undefined && current?.permissionChangeOwner === owner))
    );
  };
  return {
    kind: "active" as const,
    stop: () => {
      if (ownsRuntime()) {
        currentHandle()?.abort();
      }
    },
    apply: async (
      mode: Parameters<typeof applyPermissionMode>[0],
      revokeApprovals: (authority: AgentRunDelegatedAuthority) => void,
    ): Promise<boolean> => {
      if (!ownsRuntime()) {
        return false;
      }
      const revoke = () => {
        if (!ownsRuntime() || (authority && !validateAgentRunDelegatedAuthority(authority))) {
          throw new Error("Permission change lost its active run. Retry the request.");
        }
        if (authority) {
          revokeApprovals(authority);
        }
      };
      const apply = () => applyPermissionMode(mode, revoke);
      const applied = await (owner ? withAuthorizedPermissionChange(owner, mode, apply) : apply());
      const currentOperation = getSessionControllerOperation(target.sessionKey, target);
      return (
        applied &&
        isAgentEventLifecycleGenerationCurrent(generation) &&
        (!currentOperation ||
          (currentOperation === operation && (!currentHandle() || ownsRuntime())))
      );
    },
  };
}
