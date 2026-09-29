import type { AgentEvent } from "openclaw/plugin-sdk/agent-core";
import { vi } from "vitest";
import { handleToolExecutionEnd } from "./embedded-agent-subscribe.handlers.tools.js";
import type {
  ToolCallSummary,
  ToolHandlerContext,
} from "./embedded-agent-subscribe.handlers.types.js";

export type ToolExecutionEndEvent = Omit<
  Extract<AgentEvent, { type: "tool_execution_end" }>,
  "type" | "isError"
> & { isError?: boolean };

export function endTool(ctx: ToolHandlerContext, event: ToolExecutionEndEvent) {
  return handleToolExecutionEnd(ctx, { type: "tool_execution_end", isError: false, ...event });
}

export function resultWithDetails(details: Record<string, unknown>) {
  return { details };
}

export function createTestContext() {
  const onBlockReplyFlush = vi.fn<NonNullable<ToolHandlerContext["params"]["onBlockReplyFlush"]>>();
  const onAgentEvent = vi.fn();
  const onExecutionPhase = vi.fn();
  const warn = vi.fn();
  const trace = vi.fn();
  const isEnabled = vi.fn<NonNullable<ToolHandlerContext["log"]["isEnabled"]>>(() => false);
  const ctx: ToolHandlerContext = {
    params: {
      runId: "run-test",
      sessionKey: "agent:unit-session",
      sessionId: "session-test-id",
      agentId: "agent-test-id",
      onBlockReplyFlush,
      onAgentEvent,
      onExecutionPhase,
      onToolResult: undefined,
    },
    flushBlockReplyBuffer: vi.fn(),
    hookRunner: undefined,
    log: {
      debug: vi.fn(),
      trace,
      isEnabled,
      info: vi.fn(),
      warn,
    },
    state: {
      toolMetaById: new Map<string, ToolCallSummary>(),
      toolMetas: [],
      acceptedSessionSpawns: [],
      toolSummaryById: new Set<string>(),
      liveEditDiffStateById: new Map(),
      itemActiveIds: new Set<string>(),
      itemStartedCount: 0,
      itemCompletedCount: 0,
      pendingToolMediaUrls: [],
      pendingToolMediaTrustByUrl: new Map(),
      toolAutoDeliveryMediaUrls: new Set(),
      pendingToolAudioAsVoice: false,
      deterministicApprovalPromptPending: false,
      replayState: { replayInvalid: false, hadPotentialSideEffects: false },
      messagingToolSentTexts: [],
      messagingToolSentTextsNormalized: [],
      currentSourceMessagingToolSentTextsNormalized: [],
      messagingToolSentMediaUrls: [],
      messagingToolSourceReplyPayloads: [],
      messageToolOnlySourceReplyDelivered: false,
      messagingToolSentTargets: [],
      successfulCronAdds: 0,
      deterministicApprovalPromptSent: false,
      toolExecutionSinceLastBlockReply: false,
      assistantMessageIndex: 0,
    },
    shouldEmitToolResult: () => false,
    shouldEmitToolOutput: () => false,
    emitToolSummary: vi.fn(),
    emitToolOutput: vi.fn(),
    trimMessagingToolSent: vi.fn(),
  };

  return { ctx, warn, onBlockReplyFlush, onAgentEvent, onExecutionPhase, trace, isEnabled };
}
