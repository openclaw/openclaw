import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  ContextEngine,
  ContextEngineRuntimeContext,
  ContextEngineRuntimeSettings,
  ContextEngineSessionTarget,
} from "../../context-engine/types.js";
import type { ContextEngineMaintenanceResources } from "./context-engine-maintenance-work.js";
import type { rewriteTranscriptEntriesInSessionManager } from "./transcript-rewrite.js";

type SessionManagerRewriteLock = <T>(operation: () => Promise<T> | T) => Promise<T>;

export type ContextEngineMaintenanceParams = {
  contextEngine?: ContextEngine;
  sessionId: string;
  sessionKey?: string;
  sessionTarget?: ContextEngineSessionTarget;
  sessionFile: string;
  reason: "bootstrap" | "compaction" | "turn";
  sessionManager?: Parameters<typeof rewriteTranscriptEntriesInSessionManager>[0]["sessionManager"];
  withSessionManagerRewriteLock?: SessionManagerRewriteLock;
  assertActive?: () => void;
  abortSignal?: AbortSignal;
  runtimeContext?: ContextEngineRuntimeContext;
  runtimeSettings?: ContextEngineRuntimeSettings;
  agentId?: string;
  contextEngineAgentId?: string;
  executionMode?: "foreground" | "background";
  onDeferredMaintenance?: (promise: Promise<void>) => void;
  onDeferredMaintenanceFailure?: (error: unknown) => void;
  config?: OpenClawConfig;
  disposeDeferredContextEngineAfterMaintenance?: boolean;
  factoryResources?: ContextEngineMaintenanceResources;
};
