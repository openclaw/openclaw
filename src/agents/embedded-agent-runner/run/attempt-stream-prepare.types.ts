import type { AgentMessage } from "../../../../packages/agent-core/src/types.js";
import type { DiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import type { DiagnosticEmbeddedRunOwner } from "../../../logging/diagnostic-run-activity.js";
import type { subscribeEmbeddedAgentSession } from "../../embedded-agent-subscribe.js";
import type { ToolSearchCatalogToolExecutor } from "../../tool-search.js";
import type { LlmBoundaryOptions } from "./attempt-llm-boundary.types.js";
import type { AttemptNestedToolActivityState } from "./attempt-nested-tool-activity.js";
import type { prepareEmbeddedAttemptAgentSession } from "./attempt-session-prepare.js";
import type { createEmbeddedAttemptDeferredLifecycleOwner } from "./deferred-lifecycle-owner.js";
import type { EmbeddedRunAttemptInternalParams } from "./internal-params.js";
import type { EmbeddedRunAttemptParams, StreamRunState } from "./types.js";

export type PrepareEmbeddedAttemptStreamInput = {
  attempt: EmbeddedRunAttemptInternalParams;
  agentSession: Pick<
    Awaited<ReturnType<typeof prepareEmbeddedAttemptAgentSession>>,
    | "activeSession"
    | "hookRunner"
    | "clientToolCallSlots"
    | "hasDeliveredSourceReply"
    | "markSourceReplyDelivered"
    | "builtinToolNames"
    | "coreBuiltinToolNames"
    | "replaySafeToolNames"
    | "codeModeExecToolNames"
    | "sourceReplyCapableToolNames"
    | "sideEffectToolOwners"
    | "trustedLocalMediaToolNames"
  >;
  applyPermissionMode?: (
    mode: NonNullable<EmbeddedRunAttemptParams["permissionMode"]> | null,
    revokeApprovals: () => void,
  ) => Promise<void>;
  onModelUsage?: Parameters<typeof subscribeEmbeddedAgentSession>[0]["onModelUsage"];
  readSessionForkBoundary?: () => LlmBoundaryOptions;
  projectSessionForkMessages?: (messages: AgentMessage[]) => AgentMessage[];
  runtimeChannel?: string;
  hookAgentId: string;
  diagnosticTrace: DiagnosticTraceContext;
  nestedToolActivityState: AttemptNestedToolActivityState;
  isReplaySafeTool: (tool: Parameters<ToolSearchCatalogToolExecutor>[0]["tool"]) => boolean;
  runAbortController: AbortController;
  abortRun: (isTimeout?: boolean, reason?: unknown) => void;
  markExternalAbort: () => void;
  recoverStalledModelCall?: () => boolean;
  getRunState: () => StreamRunState;
  onBlockReply: EmbeddedRunAttemptParams["onBlockReply"];
  onBlockReplyFlush: EmbeddedRunAttemptParams["onBlockReplyFlush"];
  diagnosticOwner: DiagnosticEmbeddedRunOwner;
  trajectoryRecorder?: Parameters<
    typeof createEmbeddedAttemptDeferredLifecycleOwner
  >[0]["trajectoryRecorder"];
};
