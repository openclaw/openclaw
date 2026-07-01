/**
 * Marks subagent completions consumed by requester-owned orchestration paths.
 */
import { setDetachedTaskDeliveryStatusByRunId } from "../tasks/detached-task-runtime.js";
import { ensureDeliveryState } from "./subagent-delivery-state.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import {
  persistSubagentRunsToDisk,
  restoreSubagentRunsFromDisk,
} from "./subagent-registry-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function markDescendantCompletionConsumedByRequester(params: {
  requesterSessionKey: string;
  runStartedAt: number;
  runIds: readonly string[];
  kind: NonNullable<SubagentRunRecord["delivery"]>["requesterConsumedKind"];
  deliveryTextHash?: string;
  consumerRunId?: string;
}): number {
  const requesterSessionKey = params.requesterSessionKey.trim();
  const runIds = new Set(params.runIds.map((runId) => runId.trim()).filter(Boolean));
  if (!requesterSessionKey || runIds.size === 0) {
    return 0;
  }

  restoreSubagentRunsFromDisk({ runs: subagentRuns, mergeOnly: true });

  const now = Date.now();
  let updated = 0;
  for (const [runId, entry] of subagentRuns.entries()) {
    if (!runIds.has(runId) || entry.requesterSessionKey !== requesterSessionKey) {
      continue;
    }
    const descendantStartedAt = entry.startedAt ?? entry.createdAt;
    if (typeof descendantStartedAt === "number" && descendantStartedAt < params.runStartedAt) {
      continue;
    }
    if (typeof entry.endedAt !== "number" || entry.expectsCompletionMessage !== true) {
      continue;
    }
    const delivery = ensureDeliveryState(entry);
    delivery.status = "delivered";
    delivery.deliveredAt ??= now;
    delivery.requesterConsumedAt ??= now;
    delivery.requesterConsumedKind = params.kind;
    delivery.requesterConsumedBySessionKey = requesterSessionKey;
    delivery.requesterConsumedRunStartedAt = params.runStartedAt;
    delivery.requesterConsumedMetadata = {
      ...(params.consumerRunId ? { consumerRunId: params.consumerRunId } : {}),
      ...(params.deliveryTextHash ? { deliveryTextHash: params.deliveryTextHash } : {}),
    };
    delivery.suspendedAt = undefined;
    delivery.suspendedReason = undefined;
    delivery.lastError = undefined;
    delivery.lastDropReason = undefined;
    entry.wakeOnDescendantSettle = undefined;
    try {
      setDetachedTaskDeliveryStatusByRunId({
        runId: entry.runId,
        runtime: "subagent",
        sessionKey: entry.childSessionKey,
        deliveryStatus: "delivered",
      });
    } catch {
      // The registry credit is the durable source of truth; task rows can be
      // absent in tests or after pruning and should not block cleanup.
    }
    updated += 1;
  }
  if (updated > 0) {
    persistSubagentRunsToDisk(subagentRuns);
  }
  return updated;
}
