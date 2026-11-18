import { DEFAULT_MISSING_TOOL_RESULT_TEXT } from "@openclaw/llm-core/types";
import {
  CHARS_PER_TOKEN_ESTIMATE,
  estimateStringChars,
} from "@openclaw/normalization-core/cjk-chars";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { countCompactionContentCharsFromParts } from "../../../packages/agent-core/src/harness/compaction/compaction-cut-point.js";
import {
  classifyToolPairingFacts,
  type ToolPairingMessageFact,
} from "../../../packages/agent-core/src/harness/session/tool-pairing-facts.js";
import {
  replaceCompactionReplayWindowFactContent,
  resolveCompactionReplayWindow,
} from "../../../packages/ai/src/transports/provider-compaction-replay-kernel.js";
import { isSilentAssistantFromFacts } from "../../shared/chat-message-content.js";
import {
  GOOGLE_TURN_ORDER_BOOTSTRAP_TEXT,
  needsGoogleAssistantFirstOrdering,
  sanitizeGoogleAssistantFirstOrderingWithAdapter,
} from "../../shared/google-turn-ordering.js";
import {
  createRealConversationFactClassifier,
  type RealConversationMessageFact,
} from "../compaction-real-conversation.js";
import {
  EMPTY_CONTENT_PLACEHOLDER,
  finishReplayImageContentWithAdapter,
} from "../embedded-agent-helpers/images.js";
import {
  createOpenAIResponsesReplayIdResolver,
  dropStaleOpenAIReasoningWithAdapter,
} from "../embedded-agent-helpers/openai.js";
import {
  validateReplayTurnsWithAdapter,
  type ReplayTurnAdapter,
} from "../embedded-agent-helpers/turns.js";
import {
  sanitizeToolCallInputsWithAdapter,
  sanitizeToolUseResultPairingWithAdapter,
} from "../session-transcript-repair.js";
import { stripStaleThinkingSignatures } from "../thinking-signatures.js";
import {
  rewriteToolResultIdsWithAdapter,
  sanitizeToolCallIdsForCloudCodeAssistWithAdapter,
} from "../tool-call-id.js";
import {
  isAllowedToolCallName,
  replayToolResultIds,
  type ToolReplayAdapter,
} from "../tool-call-shared.js";
import {
  dedupeDuplicateUserSequence,
  MIN_DUPLICATE_USER_MESSAGE_CHARS,
} from "./compaction-duplicate-user-messages.js";
import {
  SESSION_PRELUDE,
  literalBlock,
  type ReplayBlockFact,
  type ReplayMessageFact,
  type ExactReplaySourceFact,
  type ExactReplayContext,
  type ExactReplayReaders,
} from "./exact-replay-facts.js";
import { limitHistoryTurns } from "./history.js";
import {
  sanitizeGenericReplayWithAdapter,
  sanitizeReplayHistoryAfterProviderHooksWithAdapter,
  assertReplayToolUseResultInvariant,
  normalizeReplaySequence,
} from "./replay-history-sanitization.js";
import type { PreparedCompactionReplayOptions } from "./replay-history.types.js";
import { joinReplayTextFingerprints } from "./replay-text-facts.js";
import { transformThinkingReplay, type ThinkingReplayAdapter } from "./thinking-replay.js";
export {
  collectExactReplaySourceFact,
  resolveExactReplaySourcePolicy,
  collectExactReplayMediaFacts,
  compareExactReplayRows,
} from "./exact-replay-facts.js";
export type {
  ExactReplaySourceFact,
  ExactReplayReaders,
  ExactReplayContext,
  ExactReplayEqualityRequest,
} from "./exact-replay-facts.js";
function pairing<S>(message: ReplayMessageFact<S>): ToolPairingMessageFact {
  if (message.role === "assistant" && message.content) {
    return {
      role: "assistant",
      failed: message.stopReason === "error" || message.stopReason === "aborted",
      calls: message.content.flatMap((block, contentIndex) =>
        block.tool.idToolCall && block.tool.id
          ? [{ id: block.tool.id, name: block.tool.name, contentIndex }]
          : [],
      ),
    };
  }
  return message.role === "toolResult"
    ? {
        role: "toolResult",
        id: replayToolResultIds(message.result)[0] ?? null,
        name: message.result.name,
        synthetic: message.syntheticResult,
      }
    : { role: "other" };
}

function withContent<S>(
  message: ReplayMessageFact<S>,
  content: ReplayBlockFact<S>[],
  rewriteCheckpoint = false,
): ReplayMessageFact<S> {
  return {
    ...message,
    content,
    stringContent: undefined,
    ...(rewriteCheckpoint
      ? {
          checkpoint: replaceCompactionReplayWindowFactContent(
            message.checkpoint,
            message.content ?? [],
            content,
          ),
        }
      : {}),
  };
}

function generatedMessage<S>(
  role: "user" | "toolResult",
  text: string,
  timestamp: number,
): ReplayMessageFact<S> {
  return {
    role,
    content: [literalBlock(text)],
    sourceContentWasString: false,
    timestamp,
    timestampMissing: false,
    parsedTimestamp: timestamp,
    excluded: false,
    persistedMedia: false,
    userLabelChars: 0,
    senderId: "",
    mirrorCandidate: false,
    recoveryAnchor: false,
    hasProviderReplay: false,
    prelude: false,
    result: { ids: {} },
    syntheticResult: false,
  };
}

function toolAdapter<S>(): ToolReplayAdapter<ReplayMessageFact<S>, ReplayBlockFact<S>> {
  return {
    valid: () => true,
    role: (message) => message.role,
    content: (message) => message.content,
    block: (message, block) => ({
      ...block.tool,
      finalizedOpenAIResponses:
        message.stopReason === "toolUse" && block.tool.finalizedOpenAIResponses,
    }),
    withContent: (message, content, repair) => withContent(message, content, repair === "inputs"),
    withBlock: (block, update) => ({
      ...block,
      assistantChars:
        update.name !== undefined &&
        block.type === "toolCall" &&
        block.assistantChars !== undefined &&
        block.tool.name !== undefined
          ? block.assistantChars -
            estimateStringChars(block.tool.name) +
            estimateStringChars(update.name)
          : block.assistantChars,
      tool: {
        ...block.tool,
        ...(update.id !== undefined
          ? { id: update.id, hasIds: Boolean(update.id) || block.tool.hasIds }
          : {}),
        ...(update.name !== undefined ? { name: update.name } : {}),
        ...(update.removePartialJson
          ? { hasPartialJson: false, finalizedOpenAIResponses: false }
          : {}),
      },
    }),
    pairing,
    result: (message) => message.result,
    withResult: (message, update) => {
      const { toolName, ...ids } = update;
      return {
        ...message,
        result: { ids: { ...message.result.ids, ...ids }, name: toolName ?? message.result.name },
        resultName: toolName ?? message.resultName,
      };
    },
    timestamp: (message) => message.timestamp,
    missingResult: (params) => {
      const message = generatedMessage<S>(
        "toolResult",
        params.text ?? DEFAULT_MISSING_TOOL_RESULT_TEXT,
        params.timestamp ?? Date.now(),
      );
      return {
        ...message,
        result: { ids: { toolCallId: params.toolCallId }, name: params.toolName ?? "unknown" },
        resultName: params.toolName ?? "unknown",
        syntheticResult: true,
      };
    },
  };
}

function projectedUserContent<S>(message: ReplayMessageFact<S>): ReplayBlockFact<S>[] {
  const content = message.content ?? (message.stringContent ? [message.stringContent] : []);
  if (!message.projectedText) {
    return content;
  }
  const index = content.findIndex((block) => block.type === "text");
  if (index < 0) {
    return [message.projectedText, ...content];
  }
  return content.map((block, candidate) => (candidate === index ? message.projectedText! : block));
}

function turnAdapter<S>(): ReplayTurnAdapter<ReplayMessageFact<S>, ReplayBlockFact<S>> {
  return {
    messageKind: () => "record",
    role: (message) => message.role,
    content: (message) => message.content,
    isPresentBlock: (block) => block.present,
    isThinking: (block) => block.tool.thinking,
    isCall: (block) => block.tool.idToolCall,
    callId: (block) => normalizeOptionalString(block.tool.id),
    callName: (block) => normalizeOptionalString(block.tool.name),
    extractToolCalls: (message) => {
      const fact = pairing(message);
      return fact.role === "assistant" ? fact.calls : [];
    },
    isResultBlock: (block) => block.type === "toolResult" || block.type === "tool",
    resultMatchIds: (value) => replayToolResultIds(value.result),
    resultCanonicalId: (message) => replayToolResultIds(message.result)[0] ?? null,
    toolName: (message) => message.resultName,
    stopReason: (message) => message.stopReason,
    replaceContent: (message, content) =>
      withContent(
        message,
        content === "omitted" ? [literalBlock("[tool calls omitted]")] : [...content],
      ),
    mergeAssistant: (previous, current) => ({
      ...withContent(previous, [...(previous.content ?? []), ...(current.content ?? [])]),
      stopReason: current.stopReason || previous.stopReason,
    }),
    mergeUser: (previous, current) => ({
      ...withContent(current, [
        ...projectedUserContent(previous),
        ...projectedUserContent(current),
      ]),
      projectedText: undefined,
      timestamp: current.timestampMissing ? previous.timestamp : current.timestamp,
      timestampMissing: current.timestampMissing && previous.timestampMissing,
    }),
    canMergeUser: () => true,
  };
}

function thinkingAdapter<S>(): ThinkingReplayAdapter<ReplayMessageFact<S>, ReplayBlockFact<S>> {
  return {
    role: (message) => message.role,
    content: (message) => (message.role === "assistant" ? message.content : undefined),
    thinking: (block) => block.tool.thinking,
    signature: (block) => block.thinkingSignature,
    toolCall: (block) =>
      block.type === "toolCall" || block.type === "tool_use" || block.type === "function_call",
    replace: (message, content, placeholder) =>
      withContent(message, content.length > 0 ? content : [literalBlock(placeholder)]),
  };
}

function tokenCount<S>(messages: readonly ReplayMessageFact<S>[]): number | undefined {
  let total = 0;
  for (const message of messages) {
    if (message.excluded) {
      continue;
    }
    let chars: number;
    if (message.role === "assistant") {
      if (!message.content || message.content.some((block) => block.assistantChars === undefined)) {
        return undefined;
      }
      chars = message.content.reduce((sum, block) => sum + block.assistantChars!, 0);
    } else if (message.role === "user" || message.role === "toolResult") {
      if (message.stringContent) {
        chars = message.stringContent.contentChars!;
      } else {
        if (!message.content || message.content.some((block) => block.contentChars === undefined)) {
          return undefined;
        }
        const omissions = new Set<string>();
        let textBlocks = 0;
        let imageCount = 0;
        chars = 0;
        for (const block of message.content) {
          chars += block.contentChars!;
          imageCount += Number(block.type === "image");
          textBlocks += Number(block.hasContentText);
          if (block.omission) {
            omissions.add(block.omission);
          }
        }
        chars += Math.max(0, textBlocks - 1);
        chars = countCompactionContentCharsFromParts(chars, imageCount, [...omissions].join("\n"));
      }
      if (message.role === "user") {
        chars += message.userLabelChars;
      }
    } else {
      if (message.fixedChars === undefined) {
        return undefined;
      }
      chars = message.fixedChars;
    }
    total += Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE);
  }
  return total;
}

function realConversation<S>(message: ReplayMessageFact<S>): RealConversationMessageFact {
  if (message.fixedReal) {
    return message.fixedReal;
  }
  const toolResult = message.role === "toolResult";
  const meaningful =
    !message.excluded &&
    (message.stringContent?.meaningful ??
      message.content?.some((block) => block.meaningful) ??
      false);
  const real =
    !toolResult &&
    meaningful &&
    (message.role !== "assistant" ||
      !isSilentAssistantFromFacts(
        message.silenceOverride,
        message.content?.map((block) => block.silence),
        message.phase,
      ));
  return { real, anchor: message.role === "user" && real, toolResult };
}

function duplicateSignature<S>(message: ReplayMessageFact<S>) {
  if (message.role !== "user" || message.timestamp === undefined || message.persistedMedia) {
    return undefined;
  }
  if (message.content?.some((block) => block.duplicateInvalid)) {
    return undefined;
  }
  const text =
    message.stringContent?.duplicateText ??
    joinReplayTextFingerprints(
      (message.content ?? []).flatMap((block) =>
        block.duplicateText ? [block.duplicateText] : [],
      ),
    );
  return text.normalizedLength >= MIN_DUPLICATE_USER_MESSAGE_CHARS
    ? {
        key: JSON.stringify([message.senderId, text.length, text.hash]),
        timestamp: message.timestamp,
      }
    : undefined;
}

/** Exact sanitized metrics and gating; only explicit comparison/media callbacks can read payloads. */
export async function prepareExactCompactionReplay<S>(
  sources: readonly ExactReplaySourceFact<S>[],
  options: PreparedCompactionReplayOptions,
  context: ExactReplayContext,
  readers: ExactReplayReaders<S>,
) {
  const completed = new Set<ReplayBlockFact<S>>();
  for (const frame of classifyToolPairingFacts(sources.map((source) => source.rawPairing))) {
    const blocks = sources[frame.startIndex]!.normalized?.content ?? [];
    for (const occurrence of frame.occurrences) {
      if (occurrence.result && !occurrence.result.synthetic) {
        for (const block of blocks) {
          if (
            block.rawIndex === occurrence.contentIndex &&
            isAllowedToolCallName(block.tool.name, null)
          ) {
            completed.add(block);
          }
        }
      }
    }
  }
  type Handle = { source: ExactReplaySourceFact<S>; value?: ReplayMessageFact<S> | null };
  const normalized = normalizeReplaySequence<Handle, ReplayBlockFact<S>>(
    sources.map((source) => ({ source })),
    {
      normalize: (handle) =>
        handle.source.normalized ? { ...handle, value: handle.source.normalized } : null,
      role: (handle) => handle.value?.role ?? handle.source.role,
      sourceContentWasString: (handle) => handle.source.normalized?.sourceContentWasString ?? false,
      mirrorCandidate: (handle) => handle.value!.mirrorCandidate,
      hasCalls: (handle) => {
        const fact = pairing(handle.value!);
        return fact.role === "assistant" && fact.calls.length > 0;
      },
      hasNonemptyArrayContent: (handle) => (handle.value!.content?.length ?? 0) > 0,
      failed: (handle) =>
        handle.value!.stopReason === "error" || handle.value!.stopReason === "aborted",
      blocks: (handle) => handle.value!.content ?? [],
      blockType: (block) => {
        if (block.nullish) {
          throw new TypeError("Cannot read properties of null (reading 'type')");
        }
        return block.type;
      },
      completed: (block) => completed.has(block),
      complete: (handle, blocks) => ({
        ...handle,
        value: { ...withContent(handle.value!, blocks, true), stopReason: "toolUse" },
      }),
      recoveryAnchor: (handle) =>
        handle.source.recovery ? { ...handle, value: handle.source.recovery } : null,
    },
  );
  let step = normalized.next();
  while (!step.done) {
    const left = step.value[0].value!;
    const right = step.value[1].value!;
    const leftKey = left.content!.map((block) => block.equality).join(":");
    const rightKey = right.content!.map((block) => block.equality).join(":");
    step = normalized.next(
      leftKey === rightKey && (await readers.compareRows({ kind: "mirror", left, right })),
    );
  }
  let messages = step.value
    .map((handle) => handle.value ?? handle.source.normalized)
    .filter(
      (message): message is ReplayMessageFact<S> => message !== null && message !== undefined,
    );
  const thinking = thinkingAdapter<S>();
  const tools = toolAdapter<S>();
  const repair = (rows: ReplayMessageFact<S>[]) =>
    sanitizeToolUseResultPairingWithAdapter(rows, tools, {
      erroredAssistantResultPolicy: "drop",
      ...(options.isOpenAIResponsesApi ? { missingToolResultText: "aborted" } : {}),
    });
  messages = await sanitizeGenericReplayWithAdapter(
    { ...options, messages, preserveLatestAssistantThinking: false },
    {
      normalize: (rows) => rows,
      images: async (rows) => {
        const images: ReplayMessageFact<S>[] = [];
        for (const message of rows) {
          if (message.role === "toolResult" && !message.content) {
            images.push(withContent(message, []));
            continue;
          }
          if (
            !message.content ||
            (message.role !== "assistant" &&
              message.role !== "user" &&
              message.role !== "toolResult")
          ) {
            images.push(message);
            continue;
          }
          const indexes = message.content
            .filter((block) => block.type === "image")
            .map((block) => block.locator!.index);
          const media =
            indexes.length > 0 ? await readers.readMedia(message.source!, indexes) : undefined;
          const content = message.content.flatMap((block) => {
            if (block.type === "image") {
              const result = media?.get(block.locator!.index);
              if (!result) {
                throw new Error("Missing selected replay media outcome");
              }
              return [result.mediaUnchanged ? block : result];
            }
            if (message.role === "assistant") {
              if (!block.imageKeep) {
                return [];
              }
              return block.imageChanged && message.stopReason !== "error"
                ? [{ ...block, thinkingSignature: block.imageThinkingSignature }]
                : [block];
            }
            return [block];
          });
          const finished = finishReplayImageContentWithAdapter(message, content, {
            role: (row) => row.role,
            dropEmpty: (blocks) =>
              blocks.filter(
                (block) => block.type !== "text" || block.duplicateText?.normalizedLength !== 0,
              ),
            placeholder: () => literalBlock(EMPTY_CONTENT_PLACEHOLDER),
            hasReplay: (row) => row.hasProviderReplay,
            replace: (row, blocks) => withContent(row, blocks, row.role === "assistant"),
          });
          if (finished) {
            images.push(finished);
          }
        }
        return images;
      },
      preserveLatestThinking: () => false,
      staleSignatures: (rows) =>
        stripStaleThinkingSignatures(rows, {
          role: (message) => message.role,
          timestamp: (message) => message.parsedTimestamp,
          strip: (message) =>
            message.content
              ? withContent(
                  message,
                  message.content.map((block) =>
                    block.tool.thinking
                      ? { ...block, thinkingSignature: false, staleOpenAIReasoning: false }
                      : block,
                  ),
                )
              : message,
        }),
      invalidSignatures: (rows, preserveLatest) =>
        transformThinkingReplay(rows, thinking, "invalid-signatures", preserveLatest),
      reasoning: (rows) => transformThinkingReplay(rows, thinking, "drop-reasoning"),
      thinking: (rows) => transformThinkingReplay(rows, thinking, "drop-thinking"),
      inputs: (rows) => sanitizeToolCallInputsWithAdapter(rows, tools, options),
      pairing: repair,
      openAI: (rows) => {
        const pruned = dropStaleOpenAIReasoningWithAdapter(
          rows,
          context.latestModelSwitchTimestamp ?? undefined,
          {
            role: (message) => message.role,
            timestamp: (message) => message.parsedTimestamp,
            content: (message) => message.content ?? [],
            keep: (block) => block.present,
            reasoning: (block) => block.staleOpenAIReasoning,
            clearPairedSignature: (block) =>
              block.type === "text" && block.hasTextSignature
                ? { ...block, hasTextSignature: false }
                : block,
            replace: (message, content) => withContent(message, content, true),
          },
        );
        const resolveId = createOpenAIResponsesReplayIdResolver();
        return pruned.map((message) => {
          if (message.role === "toolResult") {
            return rewriteToolResultIdsWithAdapter({ message, resolveId, adapter: tools });
          }
          if (message.role !== "assistant" || !message.content) {
            return message;
          }
          const content = message.content.map((block) => {
            if (!block.tool.idToolCall || block.tool.id === undefined) {
              return block;
            }
            const id = resolveId(block.tool.id);
            return id === block.tool.id ? block : tools.withBlock(block, { id });
          });
          return content.some((block, index) => block !== message.content![index])
            ? withContent(message, content, true)
            : message;
        });
      },
      ids: (rows) =>
        sanitizeToolCallIdsForCloudCodeAssistWithAdapter(
          rows,
          tools,
          options.policy.toolCallIdMode,
          {
            preserveNativeAnthropicToolUseIds: options.policy.preserveNativeAnthropicToolUseIds,
            duplicateToolCallIdStyle: options.policy.duplicateToolCallIdStyle,
            preserveReplaySafeThinkingToolCallIds: options.allowProviderOwnedThinkingReplay,
            allowedToolNames: options.allowedToolNames,
          },
        ),
      // Usage and tool-result details do not contribute to any downstream replay decision.
      usage: (rows) => rows,
    },
  );
  const needsGoogleTurnOrderingMarker =
    context.builtinGoogleReplay &&
    !context.googleMarkerPresent &&
    needsGoogleAssistantFirstOrdering(messages);
  const googleOrdering = (rows: ReplayMessageFact<S>[]) =>
    sanitizeGoogleAssistantFirstOrderingWithAdapter(rows, () =>
      generatedMessage("user", GOOGLE_TURN_ORDER_BOOTSTRAP_TEXT, Date.now()),
    );
  if (context.builtinGoogleReplay) {
    messages = googleOrdering(messages);
  }
  messages = sanitizeReplayHistoryAfterProviderHooksWithAdapter(messages, options, {
    pairing: repair,
    assert: (rows) =>
      assertReplayToolUseResultInvariant(rows, {
        role: (message) => message.role,
        valid: () => true,
        resultId: (message) => replayToolResultIds(message.result)[0] ?? null,
        callIds: (message) => {
          const fact = pairing(message);
          return fact.role === "assistant" ? fact.calls.map((call) => call.id) : [];
        },
      }),
  });
  if (options.policy.applyGoogleTurnOrdering) {
    messages = googleOrdering(messages);
  }
  messages = validateReplayTurnsWithAdapter(
    messages,
    options.policy,
    options.model.api,
    turnAdapter<S>(),
  );
  const dedupe = dedupeDuplicateUserSequence(messages, {
    role: (message) => message.role,
    signature: duplicateSignature,
  });
  let dedupeStep = dedupe.next();
  while (!dedupeStep.done) {
    const [left, right] = dedupeStep.value;
    dedupeStep = dedupe.next(await readers.compareRows({ kind: "duplicate-user", left, right }));
  }
  const original = dedupeStep.value.map((message) =>
    Object.assign({}, message, { [SESSION_PRELUDE]: message.prelude }),
  );
  let current: ReplayMessageFact<S>[] = limitHistoryTurns(original, options.historyLimit);
  const checkpoint = resolveCompactionReplayWindow(
    original,
    current,
    (message) => message.checkpoint,
  );
  if (checkpoint) {
    current = [
      {
        ...withContent(original[checkpoint.ownerIndex]!, []),
        checkpoint: checkpoint.projectedFact,
      },
      ...checkpoint.suffix,
    ];
  }
  if (options.policy.repairToolUseResultPairing) {
    current = repair(current);
  }
  if (current.length === 0) {
    current = original;
  }
  const classify = createRealConversationFactClassifier();
  return {
    beforeHookMetrics: {
      messageCountOriginal: original.length,
      tokenCountOriginal: tokenCount(original),
      messageCountBefore: current.length,
      tokenCountBefore: options.observedTokenCount ?? tokenCount(current),
    },
    hasRealConversation: current.some((message) => classify(realConversation(message))),
    needsGoogleTurnOrderingMarker,
  };
}
