import type {
  ContextEngine,
  ContextEngineMaintenanceResult,
  ContextEngineRuntimeContext,
} from "../../context-engine/types.js";
import { log } from "./logger.js";
import { rewriteTranscriptEntriesInSessionFile } from "./transcript-rewrite.js";

/**
 * Attach runtime-owned transcript rewrite helpers to an existing
 * context-engine runtime context payload.
 */
export function buildContextEngineMaintenanceRuntimeContext(params: {
  sessionId: string;
  sessionKey?: string;
  sessionFile: string;
  runtimeContext?: ContextEngineRuntimeContext;
}): ContextEngineRuntimeContext {
  return {
    ...params.runtimeContext,
    rewriteTranscriptEntries: async (request) =>
      await rewriteTranscriptEntriesInSessionFile({
        sessionFile: params.sessionFile,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        request,
      }),
  };
}

/**
 * Run optional context-engine transcript maintenance and normalize the result.
 */
export async function runContextEngineMaintenance(params: {
  contextEngine?: ContextEngine;
  sessionId: string;
  sessionKey?: string;
  sessionFile: string;
  reason: "bootstrap" | "compaction" | "turn";
  runtimeContext?: ContextEngineRuntimeContext;
}): Promise<ContextEngineMaintenanceResult | undefined> {
  if (typeof params.contextEngine?.maintain !== "function") {
    return undefined;
  }

  try {
    const result = await params.contextEngine.maintain({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      sessionFile: params.sessionFile,
      runtimeContext: buildContextEngineMaintenanceRuntimeContext({
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        sessionFile: params.sessionFile,
        runtimeContext: params.runtimeContext,
      }),
    });
    if (result.changed) {
      log.info(
        `[context-engine] maintenance(${params.reason}) changed transcript ` +
          `rewrittenEntries=${result.rewrittenEntries} bytesFreed=${result.bytesFreed} ` +
          `sessionKey=${params.sessionKey ?? params.sessionId ?? "unknown"}`,
      );
    }
    return result;
  } catch (err) {
    log.warn(`context engine maintain failed (${params.reason}): ${String(err)}`);
    return undefined;
  }
}
