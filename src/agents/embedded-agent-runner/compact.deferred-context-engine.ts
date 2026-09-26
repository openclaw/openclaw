import type {
  ContextEngine,
  ContextEngineRuntimeContext,
  ContextEngineRuntimeSettings,
} from "../../context-engine/types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { DEFERRED_CONTEXT_ENGINE_COMPACTION_REASON } from "./compact-reasons.js";
import { projectQueuedCompactionSessionTarget } from "./compact.queued-execution.js";
import type { CompactEmbeddedAgentSessionParams } from "./compact.types.js";
import type { ContextEngineMaintenanceResources } from "./context-engine-maintenance-work.js";
import { runContextEngineMaintenance } from "./context-engine-maintenance.js";
import { log } from "./logger.js";
import type { EmbeddedAgentCompactResult } from "./types.js";

const DEFERRED_CONTEXT_ENGINE_COMPACTION_SCHEDULE_FAILURE_REASON =
  "failed to schedule background context-engine maintenance";

export async function deferOwningContextEngineBudgetCompaction(params: {
  compactParams: CompactEmbeddedAgentSessionParams;
  contextEngineSessionKey?: string;
  contextEngine: ContextEngine;
  contextEngineRuntimeContext: ContextEngineRuntimeContext;
  contextEngineRuntimeSettings: ContextEngineRuntimeSettings;
  onDeferredMaintenance: (completion: Promise<void>) => void;
  factoryResources: ContextEngineMaintenanceResources;
}): Promise<EmbeddedAgentCompactResult> {
  let deferredScheduled = false;
  let deferredScheduleFailure: unknown;
  try {
    await runContextEngineMaintenance({
      contextEngine: params.contextEngine,
      sessionId: params.compactParams.sessionId,
      sessionKey: params.contextEngineSessionKey ?? params.compactParams.sessionKey,
      sessionTarget: projectQueuedCompactionSessionTarget(params.compactParams),
      sessionFile: params.compactParams.sessionFile,
      reason: "turn",
      runtimeContext: params.contextEngineRuntimeContext,
      runtimeSettings: params.contextEngineRuntimeSettings,
      config: params.compactParams.config,
      contextEngineAgentId: params.compactParams.contextEngineAgentId,
      disposeDeferredContextEngineAfterMaintenance: true,
      factoryResources: params.factoryResources,
      onDeferredMaintenance: (completion) => {
        deferredScheduled = true;
        params.onDeferredMaintenance(completion);
      },
      onDeferredMaintenanceFailure: (error) => {
        deferredScheduleFailure = error;
      },
    });
  } catch (err) {
    log.warn("failed to defer context-engine budget compaction", {
      errorMessage: formatErrorMessage(err),
    });
  }

  if (!deferredScheduled || deferredScheduleFailure) {
    log.warn(
      `[compaction] failed to schedule context-engine-owned budget compaction background maintenance ` +
        `(sessionKey=${params.compactParams.sessionKey ?? params.compactParams.sessionId}` +
        `${deferredScheduleFailure ? ` error=${formatErrorMessage(deferredScheduleFailure)}` : ""})`,
    );
    return {
      ok: false,
      compacted: false,
      reason: DEFERRED_CONTEXT_ENGINE_COMPACTION_SCHEDULE_FAILURE_REASON,
      failure: { reason: "deferred_compaction_not_scheduled" },
    };
  }

  log.info(
    `[compaction] deferred context-engine-owned budget compaction to background maintenance ` +
      `(sessionKey=${params.compactParams.sessionKey ?? params.compactParams.sessionId} ` +
      `scheduled=${String(deferredScheduled)})`,
  );
  return {
    ok: true,
    compacted: false,
    reason: DEFERRED_CONTEXT_ENGINE_COMPACTION_REASON,
  };
}
