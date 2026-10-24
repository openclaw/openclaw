import { performance } from "node:perf_hooks";
import { WorkerTaskError } from "@openclaw/worker-runtime";
import { getRuntimeConfig } from "../../../config/config.js";
import { readSessionEntryReadOnlyInWorker } from "../../../config/sessions/session-entry-read-runtime.js";
import { WRITE_SCOPE } from "../../../gateway/operator-scopes.js";
import type { GatewayContextResolver } from "../../../gateway/server-methods/types.js";
import type { GatewayStartupTrace } from "../../../gateway/server-startup-trace.js";
import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../../../infra/agent-events.js";
import { GatewayOperatorRecoveryAuthorizationError } from "../../../infra/restart-recovery-errors.js";
import { isSystemEventStoreCurrent } from "../../../infra/system-event-ownership.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import {
  bindGatewayContextResolver,
  getGatewayContextResolver as getEntryGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { onSessionIdentityMutation } from "../../../sessions/session-lifecycle-events.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { readRestartRecoveryRequesterSource } from "../../requester-run-recovery-source.js";
import { resolveSubagentChildAuthority } from "./subagent-child-owner-match.js";
import { resolveSubagentChildSessionOwner } from "./subagent-child-session-owner.js";
import { getCurrentSubagentRunOwner, subagentRuns } from "./subagent-registry-memory.js";
import {
  mutateSubagentRuns,
  assertSubagentRegistryWriteSourceCurrent,
  SubagentRegistryMutationRejectedError,
} from "./subagent-registry-persistence.js";
import { isRetiredSubagentExecution } from "./subagent-registry-restart-recovery-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import {
  isRequesterSettleWakeForRun,
  sameRequesterSettleRunIdentity,
} from "./subagent-requester-settle-identity.js";
import { getSubagentRunRuntimeKey } from "./subagent-run-generation.js";

type ActivationMetrics = {
  authorityRestoreMs: number;
  publishMs: number;
  recoveredRuns: number;
  publishedRuns: number;
};

const log = createSubsystemLogger("agents/subagents");
// Worker admission and unavailable policy startup retry; revoked custody never re-arms itself.
const deferredCompletionSources = new WeakSet<object>();
const unrestorableCompletionSources = new WeakMap<object, string>();

/** The private child claim preserves channel facts; the registry still owns its continuation. */
async function restoreChannelSubagentCompletionSource(
  entry: SubagentRunRecord,
  resolver: GatewayContextResolver,
  gateway: NonNullable<ReturnType<GatewayContextResolver>>,
  assertCurrent: () => void,
  assertGatewayCurrent: () => void,
) {
  if (!entry.requesterAgentId || !entry.requesterStorePath || !entry.completionRequesterSessionId) {
    return undefined;
  }
  const requester = {
    agentId: entry.requesterAgentId,
    sessionKey: entry.requesterSessionKey,
    storePath: entry.requesterStorePath,
    projection: "list" as const,
  };
  const revoked = new AbortController();
  const releaseIdentity = onSessionIdentityMutation((mutation) => {
    if (
      mutation.agentId === requester.agentId &&
      (mutation.previous.sessionId === entry.completionRequesterSessionId ||
        mutation.previous.sessionKeys.includes(requester.sessionKey))
    ) {
      revoked.abort(new Error("Subagent recovery requester session changed"));
    }
  });
  let retained = false;
  try {
    const assertPreparing = () => {
      assertCurrent();
      revoked.signal.throwIfAborted();
    };
    const child = {
      ...resolveSubagentChildSessionOwner(entry, getRuntimeConfig()),
      sessionKey: entry.childSessionKey,
      projection: "list" as const,
    };
    const childEntry = await readSessionEntryReadOnlyInWorker(child, assertPreparing);
    if (
      !childEntry ||
      resolveSubagentChildAuthority(entry, childEntry).status !== "verified" ||
      childEntry.restartRecoveryOperatorSource
    ) {
      return undefined;
    }
    const requesterOrigin = readRestartRecoveryRequesterSource({
      ...child,
      entry: childEntry,
      sourceRunId: entry.runId,
    });
    if (!requesterOrigin || requesterOrigin.operatorProfileId) {
      return undefined;
    }
    const requesterEntry = await readSessionEntryReadOnlyInWorker(requester, assertPreparing);
    if (
      requesterEntry?.sessionId !== entry.completionRequesterSessionId ||
      requesterEntry.lifecycleRevision !== entry.completionRequesterLifecycleRevision
    ) {
      return undefined;
    }
    const [
      { captureOperatorToolGatewayContinuationContext },
      { createSyntheticPluginRuntimeClient },
    ] = await Promise.all([
      import("../../../gateway/server-plugin-in-process-authority.js"),
      import("../../../gateway/server-plugin-runtime-client.js"),
    ]);
    assertPreparing();
    const scope = {
      client: createSyntheticPluginRuntimeClient({
        operatorRoleActor: { kind: "system" },
        scopes: [WRITE_SCOPE],
      }),
      context: gateway,
      resolveGatewayContext: resolver,
      isWebchatConnect: () => false,
    };
    const continuation = await withPluginRuntimeGatewayRequestScope(scope, () =>
      captureOperatorToolGatewayContinuationContext(child),
    );
    if (!continuation) {
      return undefined;
    }
    const assertSourceCurrent = () => {
      assertGatewayCurrent();
      revoked.signal.throwIfAborted();
      continuation.assertCurrent();
    };
    const client = createSyntheticPluginRuntimeClient({
      operatorRoleActor: { kind: "system" },
      scopes: continuation.scopes,
      agentToolCaller: {
        agentId: child.agentId,
        sessionKey: child.sessionKey,
        requesterOrigin,
        assertCurrent: assertSourceCurrent,
      },
    });
    retained = true;
    return {
      ...continuation,
      assertCurrent: assertSourceCurrent,
      signal: AbortSignal.any([continuation.signal, revoked.signal]),
      release() {
        releaseIdentity();
        continuation.release();
      },
      run<T>(run: () => T): T {
        assertSourceCurrent();
        return continuation.run(() =>
          withPluginRuntimeGatewayRequestScope(
            { ...getPluginRuntimeGatewayRequestScope(), ...scope, client },
            run,
          ),
        );
      },
    };
  } finally {
    if (!retained) {
      releaseIdentity();
    }
  }
}

/** Only the restoration owner may classify missing or denied original authority. */
export function getUnrestorableSubagentCompletionSourceReason(
  entry: SubagentRunRecord,
): string | undefined {
  return unrestorableCompletionSources.get(getSubagentRunRuntimeKey(entry));
}

async function restoreSubagentCompletionSource(
  entry: SubagentRunRecord,
  resolver: GatewayContextResolver,
  isGatewayCurrent: () => boolean,
  metrics?: ActivationMetrics,
): Promise<void> {
  const runtimeKey = getSubagentRunRuntimeKey(entry);
  deferredCompletionSources.delete(runtimeKey);
  unrestorableCompletionSources.delete(runtimeKey);
  if (
    (entry.collect && entry.execution.status === "terminal") ||
    (entry.execution.status === "terminal" &&
      !entry.requesterSettleWake &&
      entry.cleanupCompletedAt !== undefined)
  ) {
    return;
  }
  // A refused restoration must leave a restricted row, never a synthetic system caller.
  subagentRuns.requireCompletionAuthority(entry);
  if (
    (entry.execution.status === "terminal" || !entry.operatorRecoverySource) &&
    !entry.requesterSettleWake &&
    (entry.suppressCompletionDelivery ||
      (entry.delivery?.status === "suspended" &&
        entry.delivery.disposition === "intentional_non_delivery"))
  ) {
    return;
  }
  const beforeRestore = performance.now();
  let releaseRestored: (() => void) | undefined;
  let continuation:
    | Awaited<
        ReturnType<
          typeof import("../../../gateway/server-plugin-in-process-authority.js").captureOperatorToolGatewayContinuationContext
        >
      >
    | undefined;
  try {
    const source = entry.operatorRecoverySource;
    const missingSourceReason =
      "The original operator source was not saved for this requester continuation";
    if (
      source &&
      (source.agentId !== entry.requesterAgentId ||
        source.sessionKey !== entry.requesterSessionKey ||
        source.sessionId !== entry.completionRequesterSessionId ||
        source.lifecycleRevision !== entry.completionRequesterLifecycleRevision)
    ) {
      unrestorableCompletionSources.set(
        runtimeKey,
        "The original operator source does not match this requester continuation",
      );
    }
    const gateway = resolver();
    const storePath = entry.requesterStorePath;
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const context = captureOpenClawStateWorkerContext();
    const assertGatewayCurrent = () => {
      assertSubagentRegistryWriteSourceCurrent(context);
      if (
        !gateway ||
        !isGatewayCurrent() ||
        resolver() !== gateway ||
        !isAgentEventLifecycleGenerationCurrent(lifecycleGeneration)
      ) {
        throw new SubagentRegistryMutationRejectedError("Subagent recovery Gateway owner changed");
      }
    };
    const assertCurrent = () => {
      assertGatewayCurrent();
      const current = getCurrentSubagentRunOwner(subagentRuns, entry);
      if (
        !current ||
        subagentRuns.isCompletionAuthorityRetired(current) ||
        getEntryGatewayContextResolver(current) !== resolver
      ) {
        throw new SubagentRegistryMutationRejectedError(
          "Subagent recovery completion owner changed",
        );
      }
    };
    assertCurrent();
    if (!source) {
      if (gateway) {
        continuation = await restoreChannelSubagentCompletionSource(
          entry,
          resolver,
          gateway,
          assertCurrent,
          assertGatewayCurrent,
        );
        assertCurrent();
        if (continuation) {
          subagentRuns.bindCompletionAuthority(entry, continuation, true);
          continuation = undefined;
          unrestorableCompletionSources.delete(runtimeKey);
          return;
        }
      }
      unrestorableCompletionSources.set(runtimeKey, missingSourceReason);
      if (
        storePath &&
        entry.requesterAgentId &&
        entry.completionTarget !== "parent" &&
        (entry.requesterSettleWake?.attemptCount ?? 0) > 0
      ) {
        const { resolveRequesterSettleRecoveryCustody } =
          await import("../announce/subagent-announce-controller-source.js");
        const requester = await readSessionEntryReadOnlyInWorker(
          {
            agentId: entry.requesterAgentId,
            sessionKey: entry.requesterSessionKey,
            storePath,
          },
          assertCurrent,
        );
        assertCurrent();
        const current = getCurrentSubagentRunOwner(subagentRuns, entry);
        if (
          current &&
          sameRequesterSettleRunIdentity(current, entry) &&
          current.completionTarget !== "parent" &&
          (current.requesterSettleWake?.attemptCount ?? 0) > 0 &&
          requester?.sessionId &&
          requester.sessionId === current.completionRequesterSessionId &&
          requester.lifecycleRevision === current.completionRequesterLifecycleRevision &&
          requester.archivedAt === undefined &&
          isSystemEventStoreCurrent(
            current.requesterSessionKey,
            storePath,
            current.requesterAgentId,
          )
        ) {
          const runIds = [
            requester.restartRecoveryRequesterSource?.sourceRunId,
            ...(requester.restartRecoveryTerminalRunIds ?? []),
            ...(requester.restartRecoveryTerminalDeliveryEvidence?.map(
              (receipt) => receipt.runId,
            ) ?? []),
          ];
          for (const runId of runIds) {
            if (
              !runId ||
              !isRequesterSettleWakeForRun({
                entry: current,
                runId,
                requesterSessionKey: current.requesterSessionKey,
                requesterAgentId: current.requesterAgentId,
                runsById: subagentRuns,
              })
            ) {
              continue;
            }
            const custody = resolveRequesterSettleRecoveryCustody(requester, { runId });
            const requesterOrigin = readRestartRecoveryRequesterSource({
              entry: requester,
              agentId: entry.requesterAgentId,
              sessionKey: current.requesterSessionKey,
              sourceRunId: runId,
            });
            if (
              custody?.status === "settled" ||
              (custody?.status === "pending" &&
                requesterOrigin &&
                !requesterOrigin.operatorProfileId)
            ) {
              // Recovery owns this admitted input. Preserve only receipt reconciliation;
              // the row remains restricted and cannot start another continuation.
              unrestorableCompletionSources.delete(runtimeKey);
              deferredCompletionSources.add(runtimeKey);
              return;
            }
          }
        }
      }
      // Legacy wakes and yields may have no recoverable requester cohort or final outcome.
      // Close their unavailable continuation here; execution keeps its own recovery owner.
      deferredCompletionSources.add(runtimeKey);
      // Queue receipts and replaced-store notifications retain their settlement owners.
      if (
        entry.delivery?.queueId ||
        (entry.execution.status === "terminal" &&
          entry.execution.outcome &&
          entry.pauseReason !== "sessions_yield" &&
          entry.expectsCompletionMessage === true &&
          ["pending", "in_progress"].includes(entry.delivery?.status ?? "") &&
          entry.delivery?.deliveredAt === undefined &&
          entry.delivery?.announcedAt === undefined &&
          !isSystemEventStoreCurrent(entry.requesterSessionKey, storePath, entry.requesterAgentId))
      ) {
        return;
      }
      if (entry.execution.status === "terminal" || entry.cleanupCompletedAt !== undefined) {
        const { blockSubagentCompletionDelivery } =
          await import("../completion/subagent-completion-admission.store.js");
        if (
          await blockSubagentCompletionDelivery({
            subagent: entry,
            reason: missingSourceReason,
            disposition: "permanent_failure",
            operatorAuthorityUnavailable: true,
            context,
            assertCurrent,
          })
        ) {
          deferredCompletionSources.delete(runtimeKey);
          return;
        }
      }
    }
    if (!gateway || !source || !storePath || unrestorableCompletionSources.has(runtimeKey)) {
      throw new Error("Subagent restart recovery lacks its original operator source");
    }
    const [
      { restoreGatewayOperatorSource },
      { captureOperatorToolGatewayContinuationContext },
      { createSyntheticPluginRuntimeClient },
    ] = await Promise.all([
      import("../../../gateway/operator-run-recovery.js"),
      import("../../../gateway/server-plugin-in-process-authority.js"),
      import("../../../gateway/server-plugin-runtime-client.js"),
    ]);
    assertCurrent();
    const restored = await restoreGatewayOperatorSource({
      snapshot: source.snapshot,
      target: source,
      context: gateway,
      // Descendants retain this authority after the original completion row settles.
      assertCurrent: assertGatewayCurrent,
      prepareCurrent: async () => {
        const requester = await readSessionEntryReadOnlyInWorker(
          {
            agentId: source.agentId,
            sessionKey: source.sessionKey,
            storePath,
          },
          assertCurrent,
        );
        assertCurrent();
        if (
          requester?.sessionId !== source.sessionId ||
          requester.lifecycleRevision !== source.lifecycleRevision
        ) {
          throw new Error("Subagent restart recovery requester session changed");
        }
      },
    });
    releaseRestored = restored.release;
    assertCurrent();
    continuation = await withPluginRuntimeGatewayRequestScope(
      {
        client: createSyntheticPluginRuntimeClient({
          // Retried private inputs retain the sender fields included in their accepted hash.
          authenticatedUserProfile: restored.authenticatedUserProfile,
          operatorRoleActor: { kind: "operator", profileId: restored.authority.profileId },
          operatorRunAuthority: restored.authority,
          scopes: [...restored.authority.scopes],
        }),
        context: gateway,
        resolveGatewayContext: resolver,
        isWebchatConnect: () => false,
      },
      () => captureOperatorToolGatewayContinuationContext(),
    );
    assertCurrent();
    if (!continuation?.operatorAuthority) {
      throw new Error("Subagent restart recovery could not retain operator authority");
    }
    subagentRuns.bindCompletionAuthority(entry, continuation, true);
    continuation = undefined;
  } catch (error) {
    if (error instanceof WorkerTaskError && error.code === "overloaded") {
      deferredCompletionSources.add(runtimeKey);
      return;
    }
    const { GatewayOperatorAccessDeniedError, GatewayOperatorAccessUnavailableError } =
      await import("../../../gateway/operator-access-policy.js");
    if (error instanceof GatewayOperatorAccessUnavailableError) {
      deferredCompletionSources.add(runtimeKey);
      return;
    }
    if (
      error instanceof GatewayOperatorAccessDeniedError ||
      error instanceof GatewayOperatorRecoveryAuthorizationError
    ) {
      unrestorableCompletionSources.set(
        runtimeKey,
        "The original operator no longer has access to this requester continuation",
      );
    }
    log.warn("subagent completion authority was not restored", { runId: entry.runId, error });
  } finally {
    continuation?.release();
    releaseRestored?.();
    if (metrics) {
      metrics.authorityRestoreMs += performance.now() - beforeRestore;
    }
  }
}

/** The existing sweep retries startup dependencies while retaining the original source restriction. */
export function retryDeferredSubagentCompletionSource(
  entry: SubagentRunRecord,
): Promise<void> | undefined {
  if (!deferredCompletionSources.has(getSubagentRunRuntimeKey(entry))) {
    return undefined;
  }
  const resolver = getEntryGatewayContextResolver(entry);
  const gateway = resolver?.();
  if (resolver && gateway) {
    return restoreSubagentCompletionSource(entry, resolver, () => resolver() === gateway);
  }
  return undefined;
}

/** A closed Gateway's unfinished work acquires fresh host custody, never its old aliases. */
async function recoverSubagentRunGatewayOwner(
  expected: SubagentRunRecord,
  resolver: GatewayContextResolver,
  onRecovered: (entry: SubagentRunRecord) => void,
  isGatewayCurrent: () => boolean,
  metrics: ActivationMetrics,
): Promise<boolean> {
  const previousResolver = getEntryGatewayContextResolver(expected);
  const gateway = resolver();
  if (!previousResolver || previousResolver() !== undefined || !gateway) {
    return false;
  }
  let recovered: SubagentRunRecord | undefined;
  const beforePublish = performance.now();
  let committed: boolean;
  try {
    committed = await mutateSubagentRuns(
      [expected.runId],
      (rows) => {
        const current = rows.get(expected.runId);
        if (!current) {
          throw new SubagentRegistryMutationRejectedError(
            "Subagent Gateway recovery row disappeared",
          );
        }
        return { value: true, postimages: new Map([[current.runId, { ...current }]]) };
      },
      {
        gatewayRecovery: { expected, previousResolver, resolver, gateway },
        onPublished: (postimages) => {
          const row = postimages.get(expected.runId);
          if (row) {
            bindGatewayContextResolver(row, resolver);
            if (!row.collect) {
              subagentRuns.requireCompletionAuthority(row);
            }
            recovered = row;
            subagentRuns.commitOwnership(row);
            metrics.publishedRuns += 1;
          }
        },
      },
    );
  } finally {
    metrics.publishMs += performance.now() - beforePublish;
  }
  if (recovered) {
    metrics.recoveredRuns += 1;
    await restoreSubagentCompletionSource(recovered, resolver, isGatewayCurrent, metrics);
    if (isGatewayCurrent()) {
      onRecovered(recovered);
    }
  }
  return committed;
}

/** Activate unfinished obligations; the registry owns later retention of cold rows. */
export async function bindSubagentRunGatewayOwners(params: {
  runs: Map<string, SubagentRunRecord>;
  entries: readonly SubagentRunRecord[];
  resumedRuns: Set<object>;
  getGatewayContextResolver: () => GatewayContextResolver | undefined;
  onRecovered: (entry: SubagentRunRecord) => void;
  startupTrace?: GatewayStartupTrace;
}): Promise<boolean> {
  const resolver = params.getGatewayContextResolver();
  const gateway = resolver?.();
  if (!resolver || !gateway) {
    return false;
  }
  const isCurrent = () => params.getGatewayContextResolver() === resolver && resolver() === gateway;
  bindGatewayContextResolver(params.runs, resolver);
  const capturedRuns = params.entries;
  const metrics: ActivationMetrics = {
    authorityRestoreMs: 0,
    publishMs: 0,
    recoveredRuns: 0,
    publishedRuns: 0,
  };
  let activeRuns = 0;
  try {
    for (const snapshot of capturedRuns) {
      if (snapshot.execution.status !== "terminal") {
        activeRuns += 1;
      }
      const entry = getCurrentSubagentRunOwner(params.runs, snapshot);
      if (!entry) {
        continue;
      }
      const previous = getEntryGatewayContextResolver(entry);
      if (previous) {
        if (
          previous() ||
          (!(entry.execution.status === "terminal" && entry.requesterSettleWake) &&
            !isRetiredSubagentExecution(entry))
        ) {
          continue;
        }
        const previousResumeKey = getSubagentRunRuntimeKey(entry);
        if (
          await recoverSubagentRunGatewayOwner(
            entry,
            resolver,
            params.onRecovered,
            isCurrent,
            metrics,
          )
        ) {
          params.resumedRuns.delete(previousResumeKey);
        }
        if (!isCurrent()) {
          return false;
        }
        continue;
      }
      bindGatewayContextResolver(entry, resolver);
      await restoreSubagentCompletionSource(entry, resolver, isCurrent, metrics);
      if (!isCurrent()) {
        return false;
      }
    }
    return isCurrent();
  } finally {
    params.startupTrace?.detail("sidecars.subagent-activation", [
      ["registryActivationAuthorityRestoreMs", metrics.authorityRestoreMs],
      ["registryActivationPublishMs", metrics.publishMs],
      ["registryActivationRuns", capturedRuns.length],
      ["registryActivationActiveRuns", activeRuns],
      ["registryActivationRecoveredRuns", metrics.recoveredRuns],
      ["registryActivationPublishedRuns", metrics.publishedRuns],
    ]);
  }
}
