import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { WorkerTaskError } from "@openclaw/worker-runtime";
import { readSessionEntryReadOnlyInWorker } from "../../../config/sessions/session-entry-read-runtime.js";
import type { GatewayContextResolver } from "../../../gateway/server-methods/types.js";
import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../../../infra/agent-events.js";
import { isSystemEventStoreCurrent } from "../../../infra/system-event-ownership.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import {
  bindGatewayContextResolver,
  getGatewayContextResolver as getEntryGatewayContextResolver,
  withPluginRuntimeGatewayRequestScope,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { getCurrentSubagentRunOwner, subagentRuns } from "./subagent-registry-memory.js";
import {
  mutateSubagentRuns,
  assertSubagentRegistryWriteSourceCurrent,
  SubagentRegistryMutationRejectedError,
} from "./subagent-registry-persistence.js";
import { publishSubagentRunChanges } from "./subagent-registry-publication.js";
import { isRetiredSubagentExecution } from "./subagent-registry-restart-recovery-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { getSubagentRunRuntimeKey } from "./subagent-run-generation.js";

const log = createSubsystemLogger("agents/subagents");
// Worker admission and unavailable policy startup retry; revoked custody never re-arms itself.
const deferredCompletionSources = new WeakSet<object>();
const unrestorableCompletionSources = new WeakMap<object, string>();

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
): Promise<void> {
  const runtimeKey = getSubagentRunRuntimeKey(entry);
  deferredCompletionSources.delete(runtimeKey);
  unrestorableCompletionSources.delete(runtimeKey);
  if (
    entry.collect ||
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
    if (!source) {
      unrestorableCompletionSources.set(runtimeKey, missingSourceReason);
    } else if (
      source.agentId !== entry.requesterAgentId ||
      source.sessionKey !== entry.requesterSessionKey ||
      source.sessionId !== entry.completionRequesterSessionId ||
      source.lifecycleRevision !== entry.completionRequesterLifecycleRevision
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
    const assertCurrent = () => {
      assertSubagentRegistryWriteSourceCurrent(context);
      const current = getCurrentSubagentRunOwner(subagentRuns, entry);
      if (
        !current ||
        !gateway ||
        subagentRuns.isCompletionAuthorityRetired(current) ||
        !isGatewayCurrent() ||
        resolver() !== gateway ||
        getEntryGatewayContextResolver(current) !== resolver ||
        !isAgentEventLifecycleGenerationCurrent(lifecycleGeneration)
      ) {
        throw new SubagentRegistryMutationRejectedError(
          "Subagent recovery completion owner changed",
        );
      }
    };
    assertCurrent();
    if (!source) {
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
      assertCurrent,
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
    if (error instanceof GatewayOperatorAccessDeniedError) {
      unrestorableCompletionSources.set(
        runtimeKey,
        "The original operator no longer has access to this requester continuation",
      );
    }
    log.warn("subagent completion authority was not restored", { runId: entry.runId, error });
  } finally {
    continuation?.release();
    releaseRestored?.();
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
): Promise<boolean> {
  const previousResolver = getEntryGatewayContextResolver(expected);
  const gateway = resolver();
  if (!previousResolver || previousResolver() !== undefined || !gateway) {
    return false;
  }
  let recovered: SubagentRunRecord | undefined;
  const committed = await mutateSubagentRuns(
    [expected.runId],
    (rows) => {
      const current = rows.get(expected.runId);
      if (!current) {
        throw new SubagentRegistryMutationRejectedError(
          "Subagent Gateway recovery row disappeared",
        );
      }
      return { value: true, postimages: new Map([[current.runId, structuredClone(current)]]) };
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
        }
      },
    },
  );
  if (recovered) {
    await restoreSubagentCompletionSource(recovered, resolver, isGatewayCurrent);
    if (isGatewayCurrent()) {
      onRecovered(recovered);
    }
  }
  return committed;
}

/** Bind only the captured inventory, retaining the same Gateway across batch yields. */
export async function bindSubagentRunGatewayOwners(params: {
  runs: Map<string, SubagentRunRecord>;
  resumedRuns: Set<object>;
  getGatewayContextResolver: () => GatewayContextResolver | undefined;
  onRecovered: (entry: SubagentRunRecord) => void;
}): Promise<boolean> {
  const resolver = params.getGatewayContextResolver();
  const gateway = resolver?.();
  if (!resolver || !gateway) {
    return false;
  }
  const isCurrent = () => params.getGatewayContextResolver() === resolver && resolver() === gateway;
  // New registrations during a yield belong to the next pass, not this captured owner set.
  const capturedRuns = [...params.runs.values()];
  let visited = 0;
  for (const snapshot of capturedRuns) {
    if (++visited % 128 === 0) {
      await yieldToEventLoop();
      if (!isCurrent()) {
        return false;
      }
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
      if (await recoverSubagentRunGatewayOwner(entry, resolver, params.onRecovered, isCurrent)) {
        params.resumedRuns.delete(previousResumeKey);
      }
      if (!isCurrent()) {
        return false;
      }
      continue;
    }
    bindGatewayContextResolver(entry, resolver);
    await restoreSubagentCompletionSource(entry, resolver, isCurrent);
    if (!isCurrent()) {
      return false;
    }
    // Binding an existing owner must not supersede a registration already in preparation.
    publishSubagentRunChanges([entry.childSessionKey], [entry.runId]);
  }
  return isCurrent();
}
