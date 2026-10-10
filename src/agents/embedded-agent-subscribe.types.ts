/**
 * Public parameter types for subscribing to embedded-agent sessions.
 */
import type { HeartbeatToolResponse } from "../auto-reply/heartbeat-tool-response.js";
import type { ReasoningLevel, ThinkLevel } from "../auto-reply/thinking.js";
import type { HookRunner } from "../plugins/hooks.js";
import type { EmbeddedRunAttemptInternalParams } from "./embedded-agent-runner/run/internal-params.js";
import type { EmbeddedRunAttemptParams } from "./embedded-agent-runner/run/types.js";
import type { PreparedProviderFailoverOwner } from "./failover/provider-patterns.js";
import type { AgentMessage } from "./runtime/index.js";
import type { AgentSession } from "./sessions/index.js";
import type { NormalizedUsage } from "./usage.js";
export type { BlockReplyChunking } from "./embedded-agent-subscribe.shared-types.js";

export type SubscribeEmbeddedAgentSessionParams = Pick<
  EmbeddedRunAttemptParams,
  | "runId"
  | "lifecycleGeneration"
  | "messageChannel"
  | "initialReplayState"
  | "assistantErrorTranscript"
  | "verboseLevel"
  | "toolResultFormat"
  | "toolProgressDetail"
  | "shouldEmitToolResult"
  | "shouldEmitToolOutput"
  | "sourceReplyDeliveryMode"
  | "onToolResult"
  | "onAgentToolResult"
  | "observeToolTerminal"
  | "trajectoryRecorder"
  | "onReasoningStream"
  | "streamReasoningInNonStreamModes"
  | "onReasoningEnd"
  | "onBlockReply"
  | "onBlockReplyFlush"
  | "blockReplyBreak"
  | "blockReplyChunking"
  | "onPartialReply"
  | "onAssistantMessageStart"
  | "onAgentEvent"
  | "onToolStreamBoundary"
  | "enforceFinalTag"
  | "silentExpected"
  | "suppressLiveStreamOutput"
  | "config"
  | "sessionPersistence"
  | "sessionKey"
  | "currentChannelId"
  | "currentMessagingTarget"
  | "currentMessageId"
  | "replyToMode"
  | "hasRepliedRef"
  | "agentId"
  | "internalEvents"
> & {
  session: AgentSession;
  hookRunner?: HookRunner;
  reasoningMode?: ReasoningLevel;
  thinkingLevel?: ThinkLevel;
  /** Attempt-owned delivery proof for message-tool-only source replies. */
  hasDeliveredMessageToolOnlySourceReply?: () => boolean;
  /** Reports source delivery observed through bridged tool lifecycle events. */
  onDeliveredMessageToolOnlySourceReply?: () => void;
  /** Reports canonical completion after middleware publishes the final delivery receipt. */
  onCompletedMessageToolOnlySourceReply?: () => void;
  /** Assistant fragment usage before queued delivery; fragments may be intermediate. */
  onModelUsage?: (usage: NormalizedUsage | undefined) => void;
  onExecutionPhase?: (info: {
    phase: "tool_execution_started";
    tool?: string;
    toolCallId?: string;
    source?: string;
  }) => void;
  onHeartbeatToolResponse?: (response: HeartbeatToolResponse) => void | Promise<void>;
  /** "finishing" defers both success and error terminal ownership to the caller. */
  terminalLifecyclePhase?: "end" | "finishing";
  /** Read immediately before terminal lifecycle emission. */
  isTerminalAborted?: () => boolean | undefined;
  /** Override the terminal stop reason from the current abort owner. */
  resolveTerminalStopReason?: () => string | undefined;
  /** Same-prompt checks can retain ordinary streaming instead of buffering a draft. */
  deferTerminalDelivery?: boolean;
  /** Gate final block delivery/lifecycle after the natural answer is known. */
  onBeforeTerminalDelivery?: (event: {
    messages: AgentMessage[];
    willRetry: boolean;
    assistantEntryId?: string;
    lastAssistant?: AgentMessage;
    assistantTexts: readonly string[];
    hasAssistantVisibleText: boolean;
    isError: boolean;
    incompleteTerminalAssistant: boolean;
    hadDeterministicSideEffect: boolean;
    hasPendingContinuation: boolean;
  }) => void | Promise<void | {
    suppressTerminalDelivery?: boolean;
    continueCurrentTurn?: boolean;
  }>;
  /** Best-effort hook invoked immediately before the terminal lifecycle event is emitted. */
  onBeforeLifecycleTerminal?: () => void | Promise<void>;
  /** Prepared endpoint ownership can differ from the assistant's provider route ID. */
  providerOwner?: PreparedProviderFailoverOwner;
  compactionCountOwner?: EmbeddedRunAttemptInternalParams["compactionCountOwner"];
  onContextAccountingEvent?: EmbeddedRunAttemptInternalParams["onContextAccountingEvent"];
  currentAccountId?: string;
  /** Current transport thread resolved for this run. */
  currentThreadId?: string;
  /** Ephemeral session UUID — regenerated on /new and /reset. */
  sessionId?: string;
  /**
   * Exact raw names of OpenClaw tools registered for this run.
   */
  builtinToolNames?: ReadonlySet<string>;
  /** Exact raw names of core-owned tools registered for this run. */
  coreBuiltinToolNames?: ReadonlySet<string>;
  /** Exact registered tool names whose concrete instances are safe to replay. */
  replaySafeToolNames?: ReadonlySet<string>;
  /** Exact names of the marked Code Mode `exec` control tool(s) registered for this run. */
  codeModeExecToolNames?: ReadonlySet<string>;
  /** Exact names of tools whose author declared `canDeliverSourceReply`. */
  sourceReplyCapableToolNames?: ReadonlySet<string>;
  /** Canonical owner keys for unique plugin tools that can change durable state. */
  sideEffectToolOwners?: ReadonlyMap<string, string>;
  /**
   * Exact raw names allowed to emit local media paths for this run.
   * Includes core trusted tools plus bundled plugin tools proven from the
   * startup metadata snapshot.
   */
  trustedLocalMediaToolNames?: ReadonlySet<string>;
};
