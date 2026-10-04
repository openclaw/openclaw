import { getGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import { loadSessionEntryByKey } from "../announce/subagent-announce-delivery.runtime.js";
import { normalizeDeleteCleanupTarget } from "./subagent-delivery-state.js";
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
