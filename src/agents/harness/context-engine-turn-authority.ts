import { randomUUID } from "node:crypto";
import type { ContextEngineRuntimeContext } from "../../context-engine/types.js";
import type { QueuedOperatorRecoverySource } from "../../gateway/operator-run-recovery-source.codec.js";
import { captureQueuedOperatorRecoverySource } from "../../gateway/operator-run-recovery-source.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  prepareSystemAgentRunAdmission,
  readRunOperatorAuthority,
  runWithPreparedRunSourceScope,
  type PreparedAgentRunAdmission,
} from "../admitted-run-context.js";
import { runContextEngineMaintenance } from "../embedded-agent-runner/context-engine-maintenance.js";
import {
  attachCompactionAccountingRecorder,
  readCompactionAccountingRecorder,
} from "../embedded-agent-runner/run/compaction-accounting-bridge.js";

/** Capture only the host's recorder or admission, never source-looking public metadata. */
export function captureContextEngineTurnOperatorSource(
  runtimeContext: ContextEngineRuntimeContext | undefined,
  admission: Parameters<typeof readRunOperatorAuthority>[0],
): QueuedOperatorRecoverySource | undefined {
  const authority =
    readCompactionAccountingRecorder(runtimeContext)?.operatorAuthority ??
    readRunOperatorAuthority(admission);
  return authority?.participationCeiling
    ? captureQueuedOperatorRecoverySource(authority)
    : undefined;
}

/** Re-admit the saved source, retaining its scope until deferred work really settles. */
export async function runContextEngineTurnMaintenance(
  params: Parameters<typeof runContextEngineMaintenance>[0] & {
    operatorSource?: QueuedOperatorRecoverySource;
  },
): Promise<void> {
  const { operatorSource, ...maintenance } = params;
  if (operatorSource === undefined || typeof params.contextEngine?.maintain !== "function") {
    await runContextEngineMaintenance(maintenance);
    return;
  }
  const agentId = params.sessionTarget?.agentId;
  if (!agentId) {
    throw new Error("Durable context-engine maintenance requires its original agent.");
  }
  const scope = getPluginRuntimeGatewayRequestScope();
  const context =
    scope?.resolveGatewayContext?.() ?? scope?.context?.resolveGatewayContext?.() ?? scope?.context;
  if (!context) {
    throw new Error(
      "Durable context-engine maintenance requires its original Gateway operator source.",
    );
  }
  const { restoreGatewayQueuedOperatorRecovery } =
    await import("../../gateway/operator-run-recovery.js");
  const restored = await restoreGatewayQueuedOperatorRecovery({
    source: operatorSource,
    context,
    assertCurrent: () => {
      params.abortSignal?.throwIfAborted();
      params.assertActive?.();
    },
  });
  const deferredScheduled = createDeferredCore();
  let deferred: Promise<void> | undefined;
  const completion = (async () => {
    let preparation: PreparedAgentRunAdmission | undefined;
    try {
      const prepared = (preparation = prepareSystemAgentRunAdmission(
        params.config ?? context.getRuntimeConfig(),
        `context-engine-maintenance:${randomUUID()}`,
        agentId,
        "context-engine.turn.maintenance",
        params.assertActive,
        restored.authority,
      ));
      await runWithPreparedRunSourceScope({ preparedRunAdmission: prepared }, async () => {
        await prepared.admit("embedded");
        const runtimeContext = { ...params.runtimeContext };
        attachCompactionAccountingRecorder(runtimeContext, {
          operatorAuthority: restored.authority,
        });
        await runContextEngineMaintenance({
          ...maintenance,
          runtimeContext,
          abortSignal:
            params.abortSignal && restored.authority.signal
              ? AbortSignal.any([params.abortSignal, restored.authority.signal])
              : (params.abortSignal ?? restored.authority.signal),
          assertActive: () => {
            prepared.assertCurrent();
            prepared.assertSourceCurrent();
          },
          onDeferredMaintenance: (promise) => {
            deferred = promise;
          },
        });
        if (deferred) {
          deferredScheduled.resolve();
          await deferred;
        }
      });
    } finally {
      preparation?.close();
      restored.release();
    }
  })();
  // The scheduler snapshots this source scope. Its prepared reads and live admission
  // must outlive that snapshot, not just the foreground scheduling call.
  await Promise.race([completion, deferredScheduled.promise]);
  if (deferred) {
    params.onDeferredMaintenance?.(completion);
  }
}
