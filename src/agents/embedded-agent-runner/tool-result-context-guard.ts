import type {
  ContextEngine,
  ContextEngineRuntimeContext,
  ContextEngineRuntimeSettings,
  ContextEngineSessionTarget,
} from "../../context-engine/types.js";
import { projectRecordedModelPrompt } from "../../sessions/user-turn-transcript.message.js";
import { estimateTokens, type AgentMessage } from "../runtime/index.js";
import { resolveToolResultContextMaxChars } from "../tool-result-limits.js";
import { formatContextLimitTruncationNotice } from "./context-truncation-notice.js";
import { estimateRenderedLlmBoundaryTokenPressure } from "./run/preemptive-compaction.js";
import {
  TOOL_IMAGE_CHARS,
  TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE,
  type MessageCharEstimateCache,
  createMessageCharEstimateCache,
  estimateMessageChars,
  estimateMessageCharsCached,
  getToolResultText,
  isToolResultMessage,
} from "./tool-result-char-estimator.js";
import { isToolResultTextBlock } from "./tool-result-text-budget.js";
import { truncateToolResultMessage, truncateToolResultText } from "./tool-result-truncation.js";

type GuardableTransformContext = (
  messages: AgentMessage[],
  signal: AbortSignal,
) => AgentMessage[] | Promise<AgentMessage[]>;

type GuardableAgentRecord = {
  transformContext?: GuardableTransformContext;
};

function projectMessages(
  messages: AgentMessage[],
  project: (message: AgentMessage) => AgentMessage,
): AgentMessage[] {
  let changed = false;
  const projected = messages.map((message) => {
    const next = project(message);
    changed ||= next !== message;
    return next;
  });
  return changed ? projected : messages;
}

function replaceToolResultContent(
  msg: AgentMessage,
  replacement: string | unknown[],
): AgentMessage {
  const content = (msg as { content?: unknown }).content;
  const result = {
    ...msg,
    content:
      typeof replacement === "string" && !(typeof content === "string" || content === undefined)
        ? [{ type: "text", text: replacement }]
        : replacement,
  } as AgentMessage;
  Reflect.deleteProperty(result, "details");
  return result;
}

function truncateToolResultToChars(
  msg: AgentMessage,
  maxChars: number,
  cache: MessageCharEstimateCache,
): AgentMessage {
  if (!isToolResultMessage(msg)) {
    return msg;
  }

  const estimatedChars = estimateMessageCharsCached(msg, cache);
  if (estimatedChars <= maxChars) {
    return msg;
  }
  const content = (msg as { content?: unknown }).content;
  if (Array.isArray(content)) {
    const isImage = (block: unknown) =>
      Boolean(block) && typeof block === "object" && (block as { type?: unknown }).type === "image";
    const isText = (block: unknown): block is { type: "text"; text: string } =>
      isToolResultTextBlock(block) && block.type === "text";
    const imageCount = content.filter(isImage).length;
    const omissionNotice = (retainedImages: number) => {
      const omittedImages = imageCount - retainedImages;
      return (
        `[${omittedImages} image${omittedImages === 1 ? "" : "s"} omitted from context` +
        `${retainedImages === 0 ? "; no images fit the context limit" : ""}; rerun with fewer images]`
      );
    };
    const projectContent = (retainedContent: unknown[], noticeText?: string) => {
      const notice = noticeText ? [{ type: "text", text: noticeText }] : [];
      const reservedChars = estimateMessageChars(msg, [
        ...retainedContent.filter((block) => !isText(block)),
        ...notice,
      ]);
      const bounded = truncateToolResultMessage(
        replaceToolResultContent(msg, retainedContent),
        Math.max(0, maxChars - reservedChars),
        { minimumRawWeight: TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE },
      );
      return replaceToolResultContent(msg, [
        // SAFETY: Array input is preserved or mapped to another array by truncateToolResultMessage.
        ...(bounded as { content: unknown[] }).content,
        ...notice,
      ]);
    };

    // Image cost alone rules out larger prefixes. The allocator still reserves
    // other non-text content and preserves diagnostic tails and short text blocks.
    const maxRetainedImages = Math.min(imageCount, Math.floor(maxChars / TOOL_IMAGE_CHARS));
    for (let retainedImages = maxRetainedImages; retainedImages >= 0; retainedImages -= 1) {
      let seenImages = 0;
      const retainedContent = content.filter(
        (block) => !isImage(block) || ++seenImages <= retainedImages,
      );
      const projected = projectContent(
        retainedContent,
        retainedImages < imageCount ? omissionNotice(retainedImages) : undefined,
      );
      const projectedContent = (projected as { content: unknown[] }).content;
      if (
        retainedContent.some((block, index) => {
          const projectedBlock = projectedContent[index];
          return isText(block) && block.text && (!isText(projectedBlock) || !projectedBlock.text);
        })
      ) {
        continue;
      }
      if (estimateMessageCharsCached(projected, cache) <= maxChars) {
        return projected;
      }
    }
    // Dropping unfit non-text content must not flatten away surviving semantic
    // blocks. Reserve a visible notice even when only omission markers can fit.
    const omittedChars = estimateMessageChars(
      msg,
      content.filter((block) => !isText(block)),
    );
    return projectContent(
      content.filter(isText),
      imageCount > 0
        ? omissionNotice(0)
        : formatContextLimitTruncationNotice(
            Math.max(1, Math.floor(omittedChars / TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE)),
          ),
    );
  }

  const truncatedText = truncateToolResultText(getToolResultText(msg), maxChars, {
    minKeepChars: 0,
    minimumRawWeight: TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE,
  });
  return replaceToolResultContent(msg, truncatedText);
}

/**
 * Reassemble each tool-loop iteration for engines that own compaction.
 * Admitted turns advance through their accepted-turn owner; standalone
 * attempts retain their eager lifecycle and finalization checkpoint.
 */
export function installContextEngineLoopHook(params: {
  agent: object;
  contextEngine: ContextEngine;
  sessionId: string;
  sessionKey?: string;
  sessionTarget?: ContextEngineSessionTarget;
  sessionFile: string;
  tokenBudget?: number;
  reserveTokens?: () => number;
  getSystemPrompt?: () => string | undefined;
  modelId: string;
  repairAssembledMessages?: (messages: AgentMessage[]) => AgentMessage[];
  getPrePromptMessageCount?: () => number;
  onAfterTurnCheckpoint?: (messageCount: number) => void;
  deferredTurn?: { prompt: string; readonly availableTools: Set<string> };
  getRuntimeContext?: (params: {
    messages: AgentMessage[];
    prePromptMessageCount: number;
  }) => ContextEngineRuntimeContext | undefined;
  runtimeSettings?: ContextEngineRuntimeSettings;
  /** True when this turn belongs to a heartbeat run. */
  isHeartbeat?: boolean;
}): () => void {
  const { contextEngine, sessionId, sessionKey, sessionFile, tokenBudget, modelId } = params;
  const sessionIdentity = { sessionId, sessionKey };
  const mutableAgent = params.agent as GuardableAgentRecord;
  const originalTransformContext = mutableAgent.transformContext;
  let lastSeenLength: number | null = null;
  let lastAssembledView: AgentMessage[] | null = null;
  let lastSourceMessages: AgentMessage[] | null = null;

  mutableAgent.transformContext = async (messages, signal) => {
    signal?.throwIfAborted();
    const transformed = originalTransformContext
      ? await originalTransformContext.call(mutableAgent, messages, signal)
      : messages;
    signal?.throwIfAborted();
    const sourceMessages = Array.isArray(transformed) ? transformed : messages;
    const transcriptMessages = sourceMessages;
    const providerMessages = sourceMessages;
    const sourceHistoryChanged =
      lastSeenLength != null &&
      lastSourceMessages != null &&
      (transcriptMessages.length < lastSeenLength ||
        (transcriptMessages.length === lastSeenLength &&
          transcriptMessages.some((message, index) => message !== lastSourceMessages?.[index])));
    if (sourceHistoryChanged) {
      lastSeenLength = null;
      lastAssembledView = null;
    }

    // Seed the loop fence from the attempt's pre-prompt message count when available.
    // This keeps the first real post-tool-call iteration eligible for compaction even
    // if the hook's first observed call happens after tool results were appended.
    const prePromptMessageCount = Math.max(
      0,
      Math.min(
        transcriptMessages.length,
        lastSeenLength ?? params.getPrePromptMessageCount?.() ?? transcriptMessages.length,
      ),
    );

    if (transcriptMessages.length <= prePromptMessageCount) {
      lastSeenLength = prePromptMessageCount;
      lastSourceMessages = transcriptMessages;
      return lastAssembledView ?? providerMessages;
    }
    const preassemblyMessages = providerMessages.slice();
    try {
      if (!params.deferredTurn) {
        if (typeof contextEngine.afterTurn === "function") {
          await contextEngine.afterTurn({
            ...sessionIdentity,
            sessionTarget: params.sessionTarget,
            sessionFile,
            messages: transcriptMessages,
            prePromptMessageCount,
            tokenBudget,
            runtimeContext: params.getRuntimeContext?.({
              messages: transcriptMessages,
              prePromptMessageCount,
            }),
            runtimeSettings: params.runtimeSettings,
            isHeartbeat: params.isHeartbeat,
          });
        } else {
          const newMessages = transcriptMessages.slice(prePromptMessageCount);
          if (typeof contextEngine.ingestBatch === "function") {
            await contextEngine.ingestBatch({
              ...sessionIdentity,
              messages: newMessages,
              isHeartbeat: params.isHeartbeat,
            });
          } else {
            for (const message of newMessages) {
              await contextEngine.ingest({
                ...sessionIdentity,
                message,
                isHeartbeat: params.isHeartbeat,
              });
              signal?.throwIfAborted();
            }
          }
        }
        signal?.throwIfAborted();
        params.onAfterTurnCheckpoint?.(transcriptMessages.length);
      }
      lastSeenLength = transcriptMessages.length;
      lastSourceMessages = transcriptMessages;
      // An admitted turn is not in the engine's store yet. Assemble accepted
      // history separately, then retain the host-owned user/tool exchange.
      const historyLength = params.deferredTurn
        ? (params.getPrePromptMessageCount?.() ?? 0)
        : providerMessages.length;
      const pendingMessages = providerMessages.slice(historyLength);
      const pendingTokens = pendingMessages.reduce(
        (sum, message) => sum + estimateTokens(projectRecordedModelPrompt(message)),
        0,
      );
      // The pending exchange already includes the active prompt; reserve only
      // the system prompt here, using the same pressure estimate as turn start.
      const systemTokens = estimateRenderedLlmBoundaryTokenPressure({
        systemPrompt: params.getSystemPrompt?.(),
        prompt: "",
      });
      const reserve = Math.max(0, Math.floor(params.reserveTokens?.() ?? 0));
      const assembled = await contextEngine.assemble({
        ...sessionIdentity,
        messages: providerMessages.slice(0, historyLength),
        ...params.deferredTurn,
        tokenBudget:
          tokenBudget === undefined
            ? undefined
            : Math.max(1, tokenBudget - reserve - systemTokens - pendingTokens),
        model: modelId,
        runtimeSettings: params.runtimeSettings,
      });
      signal?.throwIfAborted();
      if (!assembled || !Array.isArray(assembled.messages)) {
        throw new Error("context engine assembly returned invalid messages");
      }
      const modelMessages = pendingMessages.length
        ? [...assembled.messages, ...pendingMessages]
        : assembled.messages;
      lastAssembledView = params.repairAssembledMessages?.(modelMessages) ?? modelMessages;
      return lastAssembledView;
    } catch {
      // Restore the provider array even when afterTurn mutated it before failing.
      providerMessages.splice(0, providerMessages.length, ...preassemblyMessages);
      signal?.throwIfAborted();
      // Retry from the original fence so failed assembly cannot consume history.
      lastSeenLength = prePromptMessageCount;
      lastAssembledView = null;
      lastSourceMessages = transcriptMessages;
    }

    return providerMessages;
  };

  return () => {
    mutableAgent.transformContext = originalTransformContext;
  };
}

export function installToolResultContextGuard(params: {
  agent: object;
  contextWindowTokens: number;
}): () => void {
  const maxSingleToolResultChars = resolveToolResultContextMaxChars(params.contextWindowTokens);

  // Agent.transformContext is private in session runtime, so access it via a
  // narrow runtime view to keep callsites type-safe while preserving behavior.
  const mutableAgent = params.agent as GuardableAgentRecord;
  const originalTransformContext = mutableAgent.transformContext;

  mutableAgent.transformContext = async (messages, signal) => {
    const transformed = originalTransformContext
      ? await originalTransformContext.call(mutableAgent, messages, signal)
      : messages;

    const sourceMessages = Array.isArray(transformed) ? transformed : messages;
    const estimateCache = createMessageCharEstimateCache();
    return projectMessages(sourceMessages, (message) =>
      truncateToolResultToChars(message, maxSingleToolResultChars, estimateCache),
    );
  };

  return () => {
    mutableAgent.transformContext = originalTransformContext;
  };
}
