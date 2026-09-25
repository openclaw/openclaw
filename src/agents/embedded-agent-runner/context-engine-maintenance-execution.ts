import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { publishTranscriptUpdate } from "../../config/sessions/session-accessor.js";
import { resolveContextEngineOwnerPluginId } from "../../context-engine/registry.js";
import type {
  ContextEngine,
  ContextEngineMaintenanceResult,
  ContextEngineRuntimeContext,
} from "../../context-engine/types.js";
import { SessionManager } from "../sessions/index.js";
import { withSessionManagerWrite } from "../sessions/session-manager-write-admission.js";
import { resolveContextEngineCapabilities } from "./context-engine-capabilities.js";
import type { ContextEngineMaintenanceParams } from "./context-engine-maintenance.types.js";
import { log } from "./logger.js";
import { rewriteTranscriptEntriesInSessionManager } from "./transcript-rewrite.js";
import { resolveRuntimeTranscriptReadTarget } from "./transcript-runtime-state.js";

/**
 * Attach runtime-owned transcript rewrite helpers to an existing
 * context-engine runtime context payload.
 */
function buildContextEngineMaintenanceRuntimeContext(
  params: Omit<ContextEngineMaintenanceParams, "reason"> & {
    allowDeferredCompactionExecution?: boolean;
    purpose?: string;
    contextEnginePluginId?: string;
  },
): ContextEngineRuntimeContext {
  return {
    ...params.runtimeContext,
    ...resolveContextEngineCapabilities({
      config: params.config,
      sessionKey: params.sessionKey,
      explicitAgentId: params.contextEngineAgentId,
      authProfileId: normalizeOptionalString(params.runtimeContext?.authProfileId),
      contextEnginePluginId: params.contextEnginePluginId,
      purpose: params.purpose ?? "context-engine.maintenance",
    }),
    ...(params.sessionTarget ? { sessionTarget: params.sessionTarget } : {}),
    ...(params.allowDeferredCompactionExecution ? { allowDeferredCompactionExecution: true } : {}),
    rewriteTranscriptEntries: async (request) => {
      params.assertActive?.();
      const runtimeAgentId = params.sessionTarget?.agentId ?? params.agentId;
      const runtimeSessionKey = normalizeOptionalString(
        params.sessionTarget?.sessionKey ?? params.sessionKey,
      );
      if (!runtimeSessionKey) {
        throw new Error("Context-engine transcript rewrite requires a session key");
      }
      const runtimeStorePath =
        params.sessionTarget?.storePath ??
        (runtimeAgentId
          ? resolveSessionStorePathCore(params.config?.session?.store, { agentId: runtimeAgentId })
          : undefined);
      let runtimeTarget: Awaited<ReturnType<typeof resolveRuntimeTranscriptReadTarget>> | undefined;
      const rewriteSessionManagerEntries = async () => {
        let sessionManager = params.sessionManager;
        runtimeTarget = sessionManager?.getSessionTarget();
        if (!sessionManager) {
          runtimeTarget = await resolveRuntimeTranscriptReadTarget({
            sessionId: params.sessionTarget?.sessionId ?? params.sessionId,
            sessionKey: runtimeSessionKey,
            sessionFile: params.sessionFile,
            ...(runtimeAgentId ? { agentId: runtimeAgentId } : {}),
            ...(runtimeStorePath ? { storePath: runtimeStorePath } : {}),
          });
          params.assertActive?.();
          sessionManager = SessionManager.open(runtimeTarget);
        }
        const manager = sessionManager;
        return await withSessionManagerWrite(manager, () => {
          params.abortSignal?.throwIfAborted();
          params.assertActive?.();
          return rewriteTranscriptEntriesInSessionManager({
            sessionManager: manager,
            replacements: request.replacements,
          });
        });
      };
      const result = await (params.withSessionManagerRewriteLock
        ? params.withSessionManagerRewriteLock(rewriteSessionManagerEntries)
        : rewriteSessionManagerEntries());
      params.assertActive?.();
      if (result.changed && runtimeTarget) {
        await publishTranscriptUpdate(runtimeTarget);
        params.assertActive?.();
      }
      return result;
    },
  };
}

export async function executeContextEngineMaintenance(
  params: ContextEngineMaintenanceParams & {
    contextEngine: ContextEngine;
    executionMode: "foreground" | "background";
  },
): Promise<ContextEngineMaintenanceResult | undefined> {
  if (typeof params.contextEngine.maintain !== "function") {
    return undefined;
  }
  params.abortSignal?.throwIfAborted();
  params.assertActive?.();
  const result = await params.contextEngine.maintain({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sessionTarget: params.sessionTarget,
    sessionFile: params.sessionFile,
    runtimeSettings: params.runtimeSettings,
    runtimeContext: buildContextEngineMaintenanceRuntimeContext({
      ...params,
      sessionManager: params.executionMode === "background" ? undefined : params.sessionManager,
      withSessionManagerRewriteLock:
        params.executionMode === "background" ? undefined : params.withSessionManagerRewriteLock,
      allowDeferredCompactionExecution: params.executionMode === "background",
      purpose: `context-engine.${params.reason}.maintenance`,
      contextEnginePluginId: resolveContextEngineOwnerPluginId(params.contextEngine),
    }),
    ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
  });
  params.abortSignal?.throwIfAborted();
  params.assertActive?.();
  if (result.changed) {
    log.info(
      `[context-engine] maintenance(${params.reason}) changed transcript ` +
        `rewrittenEntries=${result.rewrittenEntries} bytesFreed=${result.bytesFreed} ` +
        `sessionKey=${params.sessionKey ?? params.sessionId ?? "unknown"}`,
    );
  }
  return result;
}
