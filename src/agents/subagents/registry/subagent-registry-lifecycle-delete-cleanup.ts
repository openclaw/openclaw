import { getGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import { loadSessionEntryByKey } from "../announce/subagent-announce-delivery.runtime.js";
import { normalizeDeleteCleanupTarget } from "./subagent-delivery-state.js";
import type { SubagentLifecycleCommonContext } from "./subagent-registry-lifecycle-context.js";
import { buildSafeLifecycleErrorMeta } from "./subagent-registry-lifecycle-log.js";
import { commitSubagentLifecycleMutation } from "./subagent-registry-lifecycle-persistence.js";
import { getCurrentSubagentRunOwner } from "./subagent-registry-memory.js";
import { assertSubagentRegistryWriteSourceCurrent } from "./subagent-registry-persistence.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { deleteSubagentSessionForCleanup } from "./subagent-session-cleanup.js";

/** One physical target across delivery, failed deletion, and restored cleanup. */
export function createSubagentDeleteCleanup(params: {
  readEntry: () => SubagentRunRecord;
  commit: (mutate: (draft: SubagentRunRecord) => void) => Promise<void>;
  prepareCurrent: () => Promise<boolean>;
  isCurrent: () => boolean;
  suppress: (ownershipChanged?: boolean) => Promise<void>;
  callGateway: Parameters<typeof deleteSubagentSessionForCleanup>[0]["callGateway"];
  onError: (error: unknown) => void;
}) {
  const gatewayBinding = { resolveGatewayContext: getGatewayContextResolver(params.readEntry()) };
  let failed = false;
  const prepareTarget = async () => {
    if (!(await params.prepareCurrent())) {
      return undefined;
    }
    const entry = params.readEntry();
    const retained = normalizeDeleteCleanupTarget(entry.deleteCleanupTarget);
    if (retained) {
      return retained;
    }
    if (
      entry.deleteCleanupDispatchedAt !== undefined ||
      entry.delivery?.status === "delivered" ||
      entry.delivery?.announcedAt !== undefined
    ) {
      await params.suppress();
      return undefined;
    }
    const target = normalizeDeleteCleanupTarget(await loadSessionEntryByKey(entry.childSessionKey));
    if (!(await params.prepareCurrent())) {
      return undefined;
    }
    if (!target) {
      await params.suppress();
      return undefined;
    }
    // Capture before an external delivery can succeed but its receipt fails to persist.
    await params.commit((draft) => {
      draft.deleteCleanupTarget ??= target;
    });
    return normalizeDeleteCleanupTarget(params.readEntry().deleteCleanupTarget);
  };
  const onResult = async (outcome: "deleted" | "changed" | "failed") => {
    failed = outcome === "failed";
    if (outcome === "changed") {
      await params.suppress(true);
    }
  };
  const stamp = async () => {
    if (
      !params.isCurrent() ||
      !normalizeDeleteCleanupTarget(params.readEntry().deleteCleanupTarget)
    ) {
      return false;
    }
    await params.commit((draft) => {
      draft.deleteCleanupDispatchedAt ??= Date.now();
    });
    return params.isCurrent();
  };
  const deleteSession = async () => {
    const target = await prepareTarget();
    if (!target || !(await stamp())) {
      return;
    }
    const entry = params.readEntry();
    await onResult(
      await deleteSubagentSessionForCleanup({
        callGateway: params.callGateway,
        gatewayBinding,
        isCurrent: params.isCurrent,
        prepareCurrent: params.prepareCurrent,
        childSessionKey: entry.childSessionKey,
        spawnMode: entry.spawnMode,
        expectedSessionId: target.sessionId,
        expectedLifecycleRevision: target.lifecycleRevision,
        onError: params.onError,
      }),
    );
    assertSucceeded();
  };
  const assertSucceeded = () => {
    if (failed) {
      throw new Error("subagent session cleanup did not complete");
    }
  };
  return { prepareTarget, stamp, deleteSession, onResult, assertSucceeded };
}

/** Dispose the admitted original session before suspended bookkeeping retires its Gateway binding. */
export async function deleteSuspendedSubagentSession(
  context: SubagentLifecycleCommonContext,
  args: {
    entry: SubagentRunRecord;
    stateContext: OpenClawStateWorkerContext;
    isCurrent: () => boolean;
  },
): Promise<SubagentRunRecord> {
  let entry = args.entry;
  const assertCurrent = () => {
    assertSubagentRegistryWriteSourceCurrent(args.stateContext);
    const current = getCurrentSubagentRunOwner(context.options.runs, args.entry);
    if (!current || !args.isCurrent()) {
      throw new Error("Subagent suspended delivery cleanup owner changed.");
    }
    entry = current;
  };
  const commit = async (mutate: (draft: SubagentRunRecord) => void) => {
    assertCurrent();
    entry = await commitSubagentLifecycleMutation(context, {
      entry,
      stateContext: args.stateContext,
      assertCurrent,
      mutate,
    });
    assertCurrent();
  };
  const suppress = async (ownershipChanged = false) => {
    await commit((draft) => {
      draft.execution.suppressSessionEffects = true;
      if (ownershipChanged) {
        draft.deleteCleanupDispatchedAt = undefined;
      }
      if (ownershipChanged) {
        draft.deleteCleanupTarget = undefined;
      }
    });
  };
  assertCurrent();
  if (entry.cleanup !== "delete") {
    return entry;
  }
  if (!normalizeDeleteCleanupTarget(entry.deleteCleanupTarget)) {
    // A stamp without a target is indeterminate. Never retarget a current same-key session.
    const original =
      entry.deleteCleanupDispatchedAt === undefined
        ? normalizeDeleteCleanupTarget(entry.childSessionIdentity)
        : undefined;
    if (!original) {
      await suppress();
      return entry;
    }
    await commit((draft) => {
      draft.deleteCleanupTarget = original;
    });
  }
  const effectsCurrent = () => {
    assertCurrent();
    return (
      entry.execution.suppressSessionEffects !== true && context.sessionEffectsHostCurrent(entry)
    );
  };
  const cleanup = createSubagentDeleteCleanup({
    readEntry: () => entry,
    commit,
    suppress,
    isCurrent: effectsCurrent,
    prepareCurrent: async () => {
      if (!effectsCurrent()) {
        return false;
      }
      const suppressed = await context.shouldSuppressSessionEffects(entry);
      assertCurrent();
      if (suppressed) {
        await suppress();
      }
      return effectsCurrent();
    },
    callGateway: context.options.callGateway,
    onError: (error) =>
      context.options.warn("sessions.delete failed during suspended subagent cleanup", {
        error: buildSafeLifecycleErrorMeta(error),
      }),
  });
  // Failure retains suspension, its original pair, and Gateway binding for the next sweep.
  await cleanup.deleteSession();
  assertCurrent();
  return entry;
}
