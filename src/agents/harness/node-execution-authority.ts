import { retainPreparedSessionEntryPredicate } from "../../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import { resolveSqliteSessionKey } from "../../config/sessions/session-accessor.sqlite-scope.js";
import {
  captureSessionActorStorageOwner,
  readCapturedSessionActorEntry,
} from "../../config/sessions/session-actor-storage-binding.js";
import { withSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { SessionRowProjectionBinding } from "../../gateway/session-row-projection-binding.js";
import { capturePluginLifecycleAuthority } from "../../plugins/registry-lifecycle.js";
import { getActivePluginRegistry } from "../../plugins/runtime.js";
import {
  getGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import type { EmbeddedRunAttemptParams } from "../embedded-agent-runner/run/types.js";

type HostAttempt = Partial<EmbeddedRunAttemptParams> &
  Pick<EmbeddedRunAttemptParams, "admittedRunContext" | "runId">;
type SessionNodeInvocation = NonNullable<
  NonNullable<
    ReturnType<typeof getPluginRuntimeGatewayRequestScope>
  >["invokeWithSessionNodeAuthority"]
>;
type SessionNodeRequest = Parameters<SessionNodeInvocation>[0];
type SessionNodeGrantAuthority = NonNullable<
  NonNullable<ReturnType<typeof getPluginRuntimeGatewayRequestScope>>["nodePlacementGrantAuthority"]
>;
type SessionNodeAuthorities = {
  invokeWithSessionNodeAuthority?: SessionNodeInvocation;
  nodePlacementGrantAuthority?: SessionNodeGrantAuthority;
  release?: () => void;
};

/** Full is admitted host authority, narrowed to one placement claim, never a request flag. */
export async function createSessionNodeAuthorities(
  attempt: HostAttempt,
  pluginId: string,
  requiredNodeCommands: ReadonlySet<string>,
  assertActive: () => void,
  signal: AbortSignal,
): Promise<SessionNodeAuthorities> {
  const admittedFull = attempt.permissionMode === "full";
  const resolveContext = getGatewayContextResolver(attempt.admittedRunContext);
  const context = resolveContext?.();
  const target = attempt.sessionTarget;
  const gatewayRegistry = getActivePluginRegistry();
  const registry = getPluginRuntimeGatewayRequestScope()?.pluginRegistry ?? gatewayRegistry;
  // Prepared runs can own a separate registry; both it and the Gateway policy owner must stay live.
  const pluginOwners = [gatewayRegistry, registry].map((owner) => {
    const record = owner?.plugins.find((candidate) => candidate.id === pluginId);
    return owner && record
      ? capturePluginLifecycleAuthority(owner, record, { scopedRuntime: owner !== gatewayRegistry })
      : undefined;
  });
  const assertPlacementCurrent = getPluginRuntimeGatewayRequestScope()?.assertNodeExecutionCurrent;
  if (
    !context ||
    !target?.storePath ||
    !attempt.agentId ||
    !attempt.sessionKey ||
    !attempt.sessionId ||
    !assertPlacementCurrent
  ) {
    return {};
  }
  const session = {
    agentId: attempt.agentId,
    sessionKey: attempt.sessionKey,
    storePath: target.storePath,
  };
  const source = captureSessionActorStorageOwner(session, {
    assertCurrent: assertActive,
    authorize() {},
  });
  const readProjected = () => {
    const owner = context.sessionRowProjectionOwner;
    return owner instanceof SessionRowProjectionBinding
      ? owner.readCommittedEntry({
          agentId: session.agentId,
          storePath: session.storePath,
          key: session.sessionKey,
        })
      : undefined;
  };
  const projected = source ? undefined : readProjected();
  let retained: ReturnType<typeof retainPreparedSessionEntryPredicate> | undefined;
  let sessionAllowed = false;
  if (!source && !projected) {
    try {
      await withSessionEntryReadOnlyInWorker(session, assertActive, async (read, owner) => {
        if (!read.ok) {
          throw read.error;
        }
        const entry = read.value;
        sessionAllowed = entry?.sessionId === attempt.sessionId;
        if (owner.source) {
          const predicate = {
            databaseIdentity: `file:${owner.source.databaseIdentity}`,
            sessionKey: resolveSqliteSessionKey(session.sessionKey, session.agentId),
            entry,
          };
          retained = retainPreparedSessionEntryPredicate({
            ...predicate,
            matches: (before, after) => before?.sessionId === after?.sessionId,
          });
        }
      });
    } catch (error) {
      retained?.release();
      throw error;
    }
  }
  const assertRequestCurrent = (request: SessionNodeRequest) => {
    assertActive();
    // Full is the attempt's admitted mode; only the session occurrence is re-read here.
    const entry = source
      ? readCapturedSessionActorEntry(source, session.sessionKey)
      : projected
        ? readProjected()?.entry
        : undefined;
    const currentSessionAllowed =
      source || projected
        ? entry !== undefined && entry.sessionId === attempt.sessionId
        : sessionAllowed && retained?.isCurrent();
    if (
      signal.aborted ||
      getActivePluginRegistry() !== gatewayRegistry ||
      pluginOwners.some((isCurrent) => !isCurrent?.()) ||
      (request.source === "session-full" &&
        (attempt.permissionMode !== "full" || !requiredNodeCommands.has(request.command))) ||
      (resolveContext && resolveContext() !== context) ||
      request.pluginId !== pluginId ||
      !currentSessionAllowed ||
      request.workspace.sessionKey !== attempt.sessionKey ||
      request.workspace.sessionId !== attempt.sessionId
    ) {
      throw new Error("The run or its session ended. Start a new turn to retry.");
    }
    assertPlacementCurrent({ ...request, runId: attempt.runId, agentId: session.agentId });
  };
  const invokeWithSessionNodeAuthority: SessionNodeInvocation = async (request, invoke) => {
    if (
      request.source === "session-full" &&
      (!admittedFull || !requiredNodeCommands.has(request.command))
    ) {
      return undefined;
    }
    const assertCurrent = () => assertRequestCurrent(request);
    assertCurrent();
    const result = await invoke(assertCurrent, signal);
    assertCurrent();
    return result;
  };
  return {
    release: () => {
      retained?.release();
    },
    invokeWithSessionNodeAuthority,
    nodePlacementGrantAuthority: {
      agentId: session.agentId,
      sessionKey: attempt.sessionKey,
      runId: attempt.runId,
      assertCurrent: (request) => assertRequestCurrent({ ...request, source: "human-approved" }),
    },
  };
}
