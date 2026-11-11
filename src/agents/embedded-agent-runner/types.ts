import type { ContextEngineSessionTarget } from "../../context-engine/types.js";
import type { DiagnosticTraceContext } from "../../infra/diagnostic-trace-context.js";
import type { AcceptedSessionSpawn } from "../accepted-session-spawn.js";
import type {
  MessagingToolSend,
  MessagingToolSourceReplyPayload,
} from "../embedded-agent-messaging.types.js";
import type { McpConnectAction } from "../mcp-connect-action.js";
import type { McpAppChannelView } from "../mcp-ui-resource.js";
import type { ReplyDeliveryState } from "../reply-completion.js";
import type { EmbeddedAgentRunMeta, EmbeddedAgentRunPayload } from "./result.types.js";

export type {
  EmbeddedAgentMeta,
  EmbeddedAgentRunMeta,
  EmbeddedRunFailureSignal,
  EmbeddedRunLivenessState,
  ToolSummaryTrace,
  TraceAttempt,
} from "./result.types.js";

export type BlockReplyFlushContext =
  | {
      /** Boundary that requested the flush. */
      reason: "message_end" | "terminal";
    }
  | {
      /** Tool boundary separating pre-tool narration from the eventual answer. */
      reason: "tool_start";
      assistantMessageIndex: number;
    }
  | {
      /** Pre-compaction delivery is safe only for a completed assistant attempt. */
      reason: "pre_compaction";
      attemptAccepted: boolean;
    };

export type EmbeddedAgentRunResult = {
  latestMcpAppChannelView?: McpAppChannelView;
  latestMcpConnectAction?: McpConnectAction;
  payloads?: EmbeddedAgentRunPayload[];
  meta: EmbeddedAgentRunMeta;
  diagnosticTrace?: DiagnosticTraceContext;
  /** Suppresses confirmation text after a messaging tool successfully sends. */
  didSendViaMessagingTool?: boolean;
  // True if message_tool_only delivered a visible reply to the current source conversation.
  didDeliverSourceReplyViaMessageTool?: boolean;
  sourceReplyDelivered?: true;
  /** Current-input custody; unlike aggregate sends, this is reset when another input is admitted. */
  sourceReplyDeliveryState?: ReplyDeliveryState;
  didSendDeterministicApprovalPrompt?: boolean;
  messagingToolSentTexts?: string[];
  messagingToolSentMediaUrls?: string[];
  messagingToolSentTargets?: MessagingToolSend[];
  // Message-tool replies delivered to the active internal UI source.
  messagingToolSourceReplyPayloads?: MessagingToolSourceReplyPayload[];
  acceptedSessionSpawns?: AcceptedSessionSpawn[];
  /** An asynchronous tool task started during this run; its owner tracks completion. */
  asyncWorkStarted?: true;
  /** Completed core yield settlement, not a requester-visible final reply. */
  requesterContinuationSettled?: true;
  successfulCronAdds?: number;
};

export type EmbeddedAgentCompactResult = {
  ok: boolean;
  compacted: boolean;
  compactionKind?: "context-engine" | "native-harness" | "server-endpoint";
  reason?: string;
  /** Structured failure metadata used by model fallback classification. */
  failure?: {
    reason?: string;
    status?: number;
    code?: string;
    rawError?: string;
  };
  result?: {
    /** Identifies summaryless provider compaction in RPC and UI consumers. */
    kind?: "server-endpoint";
    sessionTarget?: ContextEngineSessionTarget;
    /** Server-endpoint compaction has no transcript summary or first-kept entry. */
    summary?: string;
    firstKeptEntryId?: string;
    tokensBefore: number;
    tokensAfter?: number;
    details?: unknown;
    sessionId?: string;
    sessionFile?: string;
  };
};

export type EmbeddedFullAccessBlockedReason = "sandbox" | "host-policy" | "channel" | "runtime";

export type EmbeddedSandboxInfo = {
  enabled: boolean;
  workspaceDir?: string;
  containerWorkspaceDir?: string;
  workspaceAccess?: "none" | "ro" | "rw";
  agentWorkspaceMount?: string;
  browserBridgeUrl?: string;
  hostBrowserAllowed?: boolean;
  elevated?: {
    allowed: boolean;
    defaultLevel: "on" | "off" | "ask" | "full";
    fullAccessAvailable: boolean;
    fullAccessBlockedReason?: EmbeddedFullAccessBlockedReason;
  };
};
