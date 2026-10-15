import { vi } from "vitest";
import type { EmbeddedAgentSubscribeContext } from "./embedded-agent-subscribe.handlers.types.js";

export function createContext(
  lastAssistant: unknown,
  overrides?: {
    onAgentEvent?: (event: unknown) => void | Promise<void>;
    onBeforeLifecycleTerminal?: () => void | Promise<void>;
    onBeforeTerminalDelivery?: () => void | Promise<void>;
    onBlockReply?: ((payload: unknown) => void) | undefined;
    onBlockReplyFlush?: () => void | Promise<void>;
    resolveTerminalStopReason?: () => string | undefined;
  },
): EmbeddedAgentSubscribeContext {
  // Terminal handlers finalize activity even when the run never started a tool.
  const hasOnBlockReplyOverride = Boolean(overrides && "onBlockReply" in overrides);
  const onBlockReply = hasOnBlockReplyOverride ? overrides?.onBlockReply : vi.fn();
  const emitBlockReply = vi.fn();
  return {
    params: {
      runId: "run-1",
      config: {},
      sessionKey: "agent:main:main",
      onAgentEvent: overrides?.onAgentEvent,
      onBeforeLifecycleTerminal: overrides?.onBeforeLifecycleTerminal,
      onBeforeTerminalDelivery: overrides?.onBeforeTerminalDelivery,
      resolveTerminalStopReason: overrides?.resolveTerminalStopReason,
      ...(onBlockReply ? { onBlockReply } : {}),
      onBlockReplyFlush: overrides?.onBlockReplyFlush,
    },
    state: {
      toolMetas: [],
      itemActiveIds: new Set(),
      itemStartedCount: 0,
      itemCompletedCount: 0,
      lastAssistant: lastAssistant as EmbeddedAgentSubscribeContext["state"]["lastAssistant"],
      liveEditDiffStateById: new Map(),
      pendingCompactionRetry: 0,
      pendingToolMediaUrls: [],
      pendingToolMediaTrustByUrl: new Map(),
      toolAutoDeliveryMediaUrls: new Set(),
      messagingToolSentMediaUrls: [],
      pendingToolAudioAsVoice: false,
      deferredBlockReplies: [],
      replayState: { replayInvalid: false, hadPotentialSideEffects: false },
    } satisfies Partial<EmbeddedAgentSubscribeContext["state"]> &
      Pick<
        EmbeddedAgentSubscribeContext["state"],
        "toolMetas" | "itemActiveIds" | "itemStartedCount" | "itemCompletedCount"
      >,
    log: {
      debug: vi.fn(),
      warn: vi.fn(),
    },
    flushBlockReplyBuffer: vi.fn(),
    emitBlockReply,
    emitAssistantStreamData: vi.fn(),
    flushAssistantStream: vi.fn(),
    releaseDeferredReplies: vi.fn(),
    clearAssistantStream: vi.fn(),
    clearDeferredBlockReplies: vi.fn(),
    resolveCompactionRetry: vi.fn(),
    maybeResolveCompactionWait: vi.fn(),
  } as unknown as EmbeddedAgentSubscribeContext;
}
