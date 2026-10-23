/**
 * Shared state and context contracts for embedded-agent subscription handlers.
 * Message, tool, compaction, and liveness handlers all mutate this single
 * state shape while keeping their implementation files decoupled.
 */
import type { ReplyDirectiveParseResult } from "../auto-reply/reply/reply-directives.js";
import type { ThinkingContent } from "../llm/types.js";
import type { HookRunner } from "../plugins/hooks.js";
import type { AssistantPhase } from "../shared/chat-message-content.js";
import type { BlockChunkMetadata, EmbeddedBlockChunker } from "./embedded-agent-block-chunker.js";
import type { BlockReplyPayload } from "./embedded-agent-payloads.js";
import type {
  EmbeddedAgentSubscribeState,
  StreamBlockState,
} from "./embedded-agent-subscribe.run-state.js";
import type {
  BlockReplyChunking,
  SubscribeEmbeddedAgentSessionParams,
} from "./embedded-agent-subscribe.types.js";
import type { AgentMessage } from "./runtime/index.js";
import type { AgentSessionEvent } from "./sessions/index.js";
export type {
  CompletedAssistantAnswer,
  EmbeddedAgentSubscribeState,
  ExecLiveItemMetadata,
  StreamBlockState,
  StreamingReplyResolver,
  ToolCallSummary,
} from "./embedded-agent-subscribe.run-state.js";

type EmbeddedSubscribeLogger = {
  debug: (message: string, meta?: Record<string, unknown>) => void;
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
};

/** User-visible assistant stream payload emitted to subscribers. */
export type AssistantStreamData = {
  text: string;
  delta: string;
  replace?: true;
  mediaUrls?: string[];
  managedMediaUrls?: string[];
  phase?: AssistantPhase;
  itemId?: string;
};

export type EmbeddedAgentSubscribeContext = {
  params: SubscribeEmbeddedAgentSessionParams;
  state: EmbeddedAgentSubscribeState;
  log: EmbeddedSubscribeLogger;
  blockChunking?: BlockReplyChunking;
  blockChunker: EmbeddedBlockChunker;
  hookRunner?: HookRunner;
  builtinToolNames?: ReadonlySet<string>;
  trustedLocalMediaToolNames?: ReadonlySet<string>;
  noteLastAssistant: (msg: AgentMessage) => void;

  shouldEmitToolResult: () => boolean;
  shouldEmitToolOutput: () => boolean;
  emitToolSummary: (
    toolName: string | undefined,
    meta: string | undefined,
    commandBearing: boolean,
  ) => void;
  emitToolOutput: (toolName?: string, meta?: string, output?: string, result?: unknown) => void;
  stripBlockTags: (text: string, state: StreamBlockState, options?: { final?: boolean }) => string;
  emitBlockChunk: (
    text: string,
    options?: Partial<BlockChunkMetadata> & {
      assistantMessageIndex?: number;
      final?: boolean;
      finalReply?: ReplyDirectiveParseResult;
    },
  ) => void;
  flushBlockReplyBuffer: (options?: {
    assistantMessageIndex?: number;
    final?: boolean;
    finalReply?: ReplyDirectiveParseResult;
  }) => void | Promise<void>;
  emitReasoningStream: (text: string | ThinkingContent, fallback?: string) => void;
  consumePartialReplyDirectives: (
    text: string,
    options?: { final?: boolean },
  ) => ReplyDirectiveParseResult | null;
  getPartialReplySourceText: () => string;
  resetPartialReplyDirectives: () => void;
  resetAssistantMessageState: (nextAssistantTextBaseline: number) => void;
  resetForCompactionRetry: () => void;
  finalizeAssistantTexts: (args: {
    text: string;
    addedDuringMessage: boolean;
    chunkerHasBuffered: boolean;
  }) => void;
  trimMessagingToolSent: () => void;
  consumeToolSendReceipt: (toolCallId: string) => unknown;
  ensureCompactionPromise: () => void;
  noteCompactionRetry: () => void;
  resolveCompactionRetry: () => void;
  maybeResolveCompactionWait: () => void;
  captureModelEvent: (evt: AgentSessionEvent) => void;
  incrementCompactionCount: () => void;
  noteCompactionTokensAfter: (value: unknown) => void;
  getCompactionCount: () => number;
  emitAssistantStreamData: (
    data: AssistantStreamData,
    options?: { emitPartialReply?: boolean; finalMessage?: boolean },
  ) => void;
  emitBlockReply: (
    payload: BlockReplyPayload,
    options?: {
      assistantMessageIndex?: number;
      consumePendingToolMedia?: boolean;
      blockSourceText?: string;
      blockSourceRange?: readonly [start: number, end: number];
    },
  ) => void;
  flushAssistantStream: () => void;
  releaseDeferredReplies: () => void;
  clearAssistantStream: () => void;
  clearDeferredBlockReplies: () => void;
};

export type ToolHandlerContext = Pick<
  EmbeddedAgentSubscribeContext,
  | "log"
  | "hookRunner"
  | "builtinToolNames"
  | "trustedLocalMediaToolNames"
  | "flushBlockReplyBuffer"
  | "shouldEmitToolResult"
  | "shouldEmitToolOutput"
  | "emitToolSummary"
  | "emitToolOutput"
  | "trimMessagingToolSent"
> & {
  params: Omit<SubscribeEmbeddedAgentSessionParams, "session">;
  state: EmbeddedAgentSubscribeState;
  consumeToolSendReceipt?: (toolCallId: string) => unknown;
};
