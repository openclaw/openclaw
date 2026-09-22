import type { SessionsDeleteParams } from "../../../../packages/gateway-protocol/src/index.js";
/**
 * Cleanup helper for subagent sessions. It deletes child session state through
 * the gateway and preserves lifecycle-hook behavior for session-mode spawns.
 */
import { SESSION_LIFECYCLE_CHANGED_ERROR_REASON } from "../../../config/sessions/lifecycle.js";
import type { GatewayContextResolver } from "../../../gateway/server-methods/types.js";
import { withPluginRuntimeGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import type { SpawnSubagentMode } from "../spawn/subagent-spawn.types.js";

type CallGateway = (options: {
  method: "sessions.delete";
  params: SessionsDeleteParams;
  timeoutMs: number;
  assertDispatchCurrent?: () => void;
}) => Promise<unknown>;
type SubagentSessionCleanupOutcome = "deleted" | "changed" | "failed";

function isSessionLifecycleChangedGatewayError(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== "GatewayClientRequestError") {
    return false;
  }
  const requestError = error as Error & { gatewayCode?: unknown; details?: unknown };
  const details = requestError.details;
  return (
    requestError.gatewayCode === "INVALID_REQUEST" &&
    typeof details === "object" &&
    details !== null &&
    (details as { reason?: unknown }).reason === SESSION_LIFECYCLE_CHANGED_ERROR_REASON
  );
}

/** Deletes a child subagent session and optionally emits session-mode lifecycle hooks. */
export async function deleteSubagentSessionForCleanup(params: {
  callGateway: CallGateway;
  /** Transferred owner; omission keeps the caller scope, undefined resolver stays unbound. */
  gatewayBinding?: { resolveGatewayContext: GatewayContextResolver | undefined };
  isCurrent?: () => boolean;
  childSessionKey: string;
  spawnMode?: SpawnSubagentMode;
  emitLifecycleHooks?: boolean;
  deleteTranscript?: boolean;
  expectedSessionId?: string;
  expectedLifecycleRevision?: string;
  timeoutMs?: number;
  onError?: (error: unknown) => void;
}): Promise<SubagentSessionCleanupOutcome> {
  if (!params.expectedSessionId || !params.expectedLifecycleRevision) {
    return "failed";
  }
  try {
    const run = () =>
      params.callGateway({
        method: "sessions.delete",
        params: {
          key: params.childSessionKey,
          deleteTranscript: params.deleteTranscript ?? true,
          emitLifecycleHooks: params.emitLifecycleHooks ?? params.spawnMode === "session",
          expectedSessionId: params.expectedSessionId,
          expectedLifecycleRevision: params.expectedLifecycleRevision,
        },
        timeoutMs: params.timeoutMs ?? 10_000,
        ...(params.isCurrent
          ? {
              assertDispatchCurrent: () => {
                if (params.isCurrent?.() === false) {
                  throw new Error("subagent cleanup owner is no longer current");
                }
              },
            }
          : {}),
      });
    // Provisional cleanup already carries its admitted Gateway in the request scope.
    await (params.gatewayBinding
      ? withPluginRuntimeGatewayContextResolver(params.gatewayBinding.resolveGatewayContext, run)
      : run());
    return "deleted";
  } catch (error) {
    if (isSessionLifecycleChangedGatewayError(error)) {
      return "changed";
    }
    params.onError?.(error);
    return "failed";
  }
}
