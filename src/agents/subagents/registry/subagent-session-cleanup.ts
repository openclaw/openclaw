import { GatewayClientRequestError } from "../../../../packages/gateway-client/src/request-error.js";
import type { SessionsDeleteParams } from "../../../../packages/gateway-protocol/src/index.js";
import { SESSION_LIFECYCLE_CHANGED_ERROR_REASON } from "../../../config/sessions/lifecycle.js";
import type { GatewayContextResolver } from "../../../gateway/server-methods/types.js";
import {
  getCanonicalGatewayContextResolver,
  getGatewayContextLifetime,
  withPluginRuntimeGatewayContextResolver,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { parseAgentSessionKey } from "../../../routing/session-key.js";
import { createLazyRuntimeModule } from "../../../shared/lazy-runtime.js";
import type { SpawnSubagentMode } from "../spawn/subagent-spawn.types.js";

// Shutdown preparation must retain this importer's promise before installed chunks can change.
export const loadSubagentSessionCleanupRuntime = createLazyRuntimeModule(
  () => import("../../../gateway/server-methods/sessions-delete.js"),
);

type CallGateway = (options: {
  method: "sessions.delete";
  params: SessionsDeleteParams;
  timeoutMs: number;
  prepareDispatchCurrent?: () => Promise<void>;
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

export async function deleteSubagentSessionForCleanup(params: {
  callGateway: CallGateway;
  /** Transferred owner; omission keeps the caller scope, undefined resolver stays unbound. */
  gatewayBinding?: { resolveGatewayContext: GatewayContextResolver | undefined };
  prepareCurrent?: () => Promise<boolean>;
  isCurrent?: () => boolean;
  childSessionKey: string;
  childAgentId?: string;
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
  const { prepareCurrent, isCurrent } = params;
  const cleanupParams: SessionsDeleteParams = {
    key: params.childSessionKey,
    ...(params.childAgentId === undefined || parseAgentSessionKey(params.childSessionKey)
      ? {}
      : { agentId: params.childAgentId }),
    deleteTranscript: params.deleteTranscript ?? true,
    emitLifecycleHooks: params.emitLifecycleHooks ?? params.spawnMode === "session",
    expectedSessionId: params.expectedSessionId,
    expectedLifecycleRevision: params.expectedLifecycleRevision,
  };
  const assertCurrent = () => {
    if (isCurrent?.() === false) {
      throw new Error("subagent cleanup owner is no longer current");
    }
  };
  const prepareDispatchCurrent = prepareCurrent
    ? async () => {
        if (!(await prepareCurrent())) {
          throw new Error("subagent cleanup owner is no longer current");
        }
      }
    : undefined;
  try {
    const run = async () => {
      const resolver = params.gatewayBinding?.resolveGatewayContext;
      if (resolver && isCurrent) {
        const owner = getCanonicalGatewayContextResolver(resolver);
        const context = owner?.();
        if (!owner || !context) {
          throw new Error("subagent cleanup Gateway owner is no longer current");
        }
        if (!context.localEmbedded) {
          const lifetime = getGatewayContextLifetime(owner).signal;
          const assertOwner = () => {
            lifetime.throwIfAborted();
            if (owner() !== context) {
              throw new Error("subagent cleanup Gateway owner is no longer current");
            }
            assertCurrent();
          };
          // Join the captured Gateway before yielding; its closed ingress is not this cleanup's owner.
          return context.trackExecution(async () => {
            assertOwner();
            await prepareDispatchCurrent?.();
            const { deleteGatewaySession } = await loadSubagentSessionCleanupRuntime();
            assertOwner();
            const result = await deleteGatewaySession({
              params: cleanupParams,
              client: null,
              context,
              assertCurrent: assertOwner,
            });
            if (!result.ok) {
              throw new GatewayClientRequestError(result.error);
            }
          });
        }
      }
      return params.callGateway({
        method: "sessions.delete",
        params: cleanupParams,
        timeoutMs: params.timeoutMs ?? 10_000,
        ...(prepareDispatchCurrent ? { prepareDispatchCurrent } : {}),
        ...(isCurrent ? { assertDispatchCurrent: assertCurrent } : {}),
      });
    };
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
