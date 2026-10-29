import { isDeepStrictEqual } from "node:util";
import { readSessionEntryReadOnlyInWorker } from "../../../config/sessions/session-entry-read-runtime.js";
import { decodeGatewayOperatorRecoverySource } from "../../../gateway/operator-run-recovery-source.js";
import { restoreGatewayOperatorSource } from "../../../gateway/operator-run-recovery.js";
import type { GatewayContextResolver } from "../../../gateway/server-methods/types.js";
import { captureOperatorToolGatewayContinuationContext } from "../../../gateway/server-plugin-in-process-authority.js";
import { createSyntheticPluginRuntimeClient } from "../../../gateway/server-plugin-runtime-client.js";
import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../../../infra/agent-events.js";
import {
  getGatewayContextResolver,
  withPluginRuntimeGatewayRequestScope,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { onSessionIdentityMutation } from "../../../sessions/session-lifecycle-events.js";
import { intersectOperatorScopes } from "../../../shared/operator-scope-compat.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import type { AdmittedRunOperatorAuthority } from "../../admitted-run-context.js";
import { getCurrentSubagentRunOwner, subagentRuns } from "./subagent-registry-memory.js";
import { assertSubagentRegistryWriteSourceCurrent } from "./subagent-registry-persistence.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { getSubagentRunRuntimeKey } from "./subagent-run-generation.js";

const deniedSources = new WeakMap<object, string>();
class RequesterSourceDeniedError extends Error {}
function isSourceDenial(error: unknown): boolean {
  return (
    error instanceof RequesterSourceDeniedError ||
    (error instanceof Error &&
      /^Restart recovery (operator (authority|source|identity|profile)|authentication owner) /.test(
        error.message,
      ))
  );
}

/** A denied source is terminal for this exact owner, not a new grant on the next sweep. */
export function getUnrestorableSubagentCompletionSourceReason(entry: SubagentRunRecord) {
  return deniedSources.get(getSubagentRunRuntimeKey(entry));
}

/** Capture from the admitted source, never from delivery routing or display attribution. */
export async function captureSubagentRequesterSource(params: {
  authority?: AdmittedRunOperatorAuthority;
  requesterAgentId?: string;
  requesterSessionKey: string;
  requesterTurnRunId?: string;
  assertCurrent: () => void;
}): Promise<SubagentRunRecord["operatorRecoverySource"]> {
  const { authority } = params;
  if (!authority?.recoverySnapshot || !params.requesterAgentId || !params.requesterTurnRunId) {
    return undefined;
  }
  params.assertCurrent();
  authority.assertCurrent();
  const entry = await readSessionEntryReadOnlyInWorker(
    {
      agentId: params.requesterAgentId,
      sessionKey: params.requesterSessionKey,
    },
    params.assertCurrent,
  );
  params.assertCurrent();
  authority.assertCurrent();
  if (entry?.incognito) {
    return undefined;
  }
  if (!entry || entry.archivedAt !== undefined) {
    throw new Error("Original requester session is unavailable for child custody");
  }
  return decodeGatewayOperatorRecoverySource({
    version: 1,
    agentId: params.requesterAgentId,
    sessionKey: params.requesterSessionKey,
    sessionId: entry.sessionId,
    ...(entry.lifecycleRevision ? { lifecycleRevision: entry.lifecycleRevision } : {}),
    sourceRunId: params.requesterTurnRunId,
    snapshot: {
      ...authority.recoverySnapshot,
      scopes: intersectOperatorScopes(authority.recoverySnapshot.scopes, authority.scopes),
    },
  });
}

/** Cold restoration reauthorizes the saved principal under current policy and exact session custody. */
export async function restoreSubagentRequesterSource(
  entry: SubagentRunRecord,
  resolver: GatewayContextResolver,
  isGatewayCurrent: () => boolean,
): Promise<void> {
  if (!entry.completionAuthorityRequired && !entry.operatorRecoverySource) {
    return;
  }
  if (subagentRuns.hasCompletionAuthority(entry)) {
    return;
  }
  subagentRuns.requireCompletionAuthority(entry);
  const key = getSubagentRunRuntimeKey(entry);
  if (deniedSources.has(key) || subagentRuns.isCompletionAuthorityRetired(entry)) {
    return;
  }
  const gateway = resolver();
  const stateContext = captureOpenClawStateWorkerContext();
  const generation = getAgentEventLifecycleGeneration();
  const revoked = new AbortController();
  let retained = false;
  let releaseRestored: (() => void) | undefined;
  let continuation: Awaited<ReturnType<typeof captureOperatorToolGatewayContinuationContext>>;
  const stop = onSessionIdentityMutation((mutation) => {
    if (
      mutation.agentId === entry.requesterAgentId &&
      (mutation.previous.sessionId === entry.operatorRecoverySource?.sessionId ||
        mutation.previous.sessionKeys.includes(entry.requesterSessionKey))
    ) {
      revoked.abort(
        new RequesterSourceDeniedError("Original requester session changed during restoration"),
      );
    }
  });
  const assertHostCurrent = () => {
    assertSubagentRegistryWriteSourceCurrent(stateContext);
    const current = getCurrentSubagentRunOwner(subagentRuns, entry);
    if (
      !gateway ||
      !isGatewayCurrent() ||
      resolver() !== gateway ||
      !isAgentEventLifecycleGenerationCurrent(generation) ||
      !current ||
      getGatewayContextResolver(current) !== resolver
    ) {
      throw new Error("Child custody restoration lost its exact runtime owner");
    }
  };
  const assertCurrent = () => {
    assertHostCurrent();
    revoked.signal.throwIfAborted();
    if (subagentRuns.isCompletionAuthorityRetired(entry)) {
      throw new RequesterSourceDeniedError("Original requester custody was retired");
    }
  };
  try {
    assertCurrent();
    if (!entry.operatorRecoverySource) {
      deniedSources.set(key, "The original requester has no restorable authentication source");
      return;
    }
    let source: NonNullable<SubagentRunRecord["operatorRecoverySource"]>;
    try {
      source = decodeGatewayOperatorRecoverySource(entry.operatorRecoverySource);
    } catch (cause) {
      throw new RequesterSourceDeniedError("Original requester source is malformed", { cause });
    }
    if (
      source.agentId !== entry.requesterAgentId ||
      source.sessionKey !== entry.requesterSessionKey ||
      (entry.requesterTurnRunId !== undefined && source.sourceRunId !== entry.requesterTurnRunId) ||
      !entry.requesterStorePath ||
      (entry.completionRequesterSessionId !== undefined &&
        source.sessionId !== entry.completionRequesterSessionId) ||
      (entry.completionRequesterLifecycleRevision !== undefined &&
        source.lifecycleRevision !== entry.completionRequesterLifecycleRevision)
    ) {
      deniedSources.set(key, "The saved source does not own this exact requester continuation");
      return;
    }
    const prepareCurrent = async () => {
      assertCurrent();
      const current = getCurrentSubagentRunOwner(subagentRuns, entry);
      if (!isDeepStrictEqual(current?.operatorRecoverySource, source)) {
        throw new RequesterSourceDeniedError("Original requester source was replaced");
      }
      const requester = await readSessionEntryReadOnlyInWorker(
        {
          agentId: source.agentId,
          sessionKey: source.sessionKey,
          storePath: entry.requesterStorePath,
        },
        assertCurrent,
      );
      assertCurrent();
      if (
        !requester ||
        requester.sessionId !== source.sessionId ||
        requester.lifecycleRevision !== source.lifecycleRevision ||
        requester.archivedAt !== undefined
      ) {
        throw new RequesterSourceDeniedError(
          "Original requester session was reset, replaced, or archived",
        );
      }
    };
    await prepareCurrent();
    const restored = await restoreGatewayOperatorSource({
      snapshot: source.snapshot,
      target: source,
      context: gateway!,
      assertCurrent,
      prepareCurrent,
    });
    releaseRestored = restored.release;
    assertCurrent();
    const client = createSyntheticPluginRuntimeClient({
      authenticatedUserProfile: restored.authenticatedUserProfile,
      operatorRoleActor: { kind: "operator", profileId: source.snapshot.profileId },
      operatorRunAuthority: restored.authority,
      scopes: source.snapshot.scopes,
    });
    continuation = await withPluginRuntimeGatewayRequestScope(
      {
        client,
        context: gateway!,
        resolveGatewayContext: resolver,
        isWebchatConnect: () => false,
      },
      () => captureOperatorToolGatewayContinuationContext(),
    );
    await prepareCurrent();
    if (!continuation?.operatorAuthority) {
      throw new RequesterSourceDeniedError("The exact requester source could not be reauthorized");
    }
    const captured = continuation;
    subagentRuns.bindCompletionAuthority(entry, {
      ...captured,
      signal: AbortSignal.any([captured.signal, revoked.signal]),
      assertCurrent() {
        assertCurrent();
        captured.assertCurrent();
      },
      run<T>(run: () => T): T {
        assertCurrent();
        return captured.run(run);
      },
      release() {
        stop();
        captured.release();
        restored.release();
      },
    });
    retained = true;
  } catch (error) {
    // Host replacement and worker failures are retryable; never classify another host's row.
    assertHostCurrent();
    if (!isSourceDenial(error)) {
      throw error;
    }
    deniedSources.set(key, "The original requester source is no longer authorized");
  } finally {
    if (!retained) {
      stop();
      continuation?.release();
      releaseRestored?.();
    }
  }
}
