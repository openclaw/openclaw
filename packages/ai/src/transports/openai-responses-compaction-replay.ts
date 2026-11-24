import type { AssistantHistoryMessage, AssistantMessage, Context, Model } from "@openclaw/llm-core";
import type {
  ResponseCompactionItemParam,
  ResponseOutputItem,
} from "openai/resources/responses/responses.js";
import { getAiTransportHost } from "../host.js";
import type { BaseOpenAIStreamOptions, CompactionReplayRejection } from "../provider-options.js";
import { resolveFailedAssistantReplay } from "../replay-turn-classification.js";
import {
  CompactionReplayRefreshRequiredError,
  createOpenAIResponsesCompactionSourceReader as createCompactionSourceReader,
  isOpenAIResponsesCompactionOutput,
  OPENAI_RESPONSES_COMPACTION_SUPPRESSION_TYPE,
  OPENAI_RESPONSES_COMPACTION_SUPPRESSION_DATA,
  readOpenAIResponsesCompactionReplayState,
  readOpenAIResponsesCompactionWindow,
  type OpenAIResponsesCompactionOutput,
  type OpenAIResponsesCompactionSource,
} from "./openai-responses-compaction-checkpoint.js";
import {
  OPENAI_RESPONSES_COMPACTION_REPLAY_TYPE,
  OPENAI_RESPONSES_RETAINED_COMPACTION_REPLAY_TYPE,
  type OpenAIResponsesCompactionReplayState,
  type OpenAIResponsesReasoningReplayMetadata,
  type ReplayableResponseCompactionItem,
} from "./openai-responses-contracts.js";
import { log } from "./openai-transport-shared.js";
import { resolveNewestCompactionReplaySource } from "./provider-compaction-checkpoint.js";
import { buildProviderReplayContext } from "./provider-replay-context.js";

export {
  CompactionReplayRefreshRequiredError,
  readOpenAIResponsesItemRecoveryAnchor,
  isSafeResponsesReplayItemId,
} from "./openai-responses-compaction-checkpoint.js";

export function captureOpenAIResponsesCompaction(
  output: Pick<AssistantMessage, "providerReplay">,
  item: ReplayableResponseCompactionItem,
  boundary: number | "retained-users",
  model: Model,
  captureMetadata?: OpenAIResponsesReasoningReplayMetadata,
  compactedOutput?: OpenAIResponsesCompactionOutput,
  outputTokens?: number,
): void {
  const metadata = captureMetadata ?? buildOpenAIResponsesReasoningReplayMetadata(model);
  if (!item.encrypted_content) {
    return;
  }
  if (!metadata?.baseUrlHash) {
    log.debug("[responses] skipping compaction capture: missing base URL hash");
    return;
  }
  const currentReplay = readOpenAIResponsesCompactionReplayState(output.providerReplay);
  if (
    typeof boundary === "number" &&
    currentReplay?.type === OPENAI_RESPONSES_COMPACTION_REPLAY_TYPE &&
    (currentReplay.replayIndex ?? -1) > boundary
  ) {
    return;
  }
  if (compactedOutput && !isOpenAIResponsesCompactionOutput(compactedOutput, model)) {
    throw new Error("Responses compact endpoint checkpoint is invalid");
  }
  const replay = {
    v: 1,
    ...(boundary === "retained-users"
      ? { type: OPENAI_RESPONSES_RETAINED_COMPACTION_REPLAY_TYPE }
      : { type: OPENAI_RESPONSES_COMPACTION_REPLAY_TYPE, replayIndex: boundary }),
    ...(item.id ? { id: item.id } : {}),
    data: item.encrypted_content,
    provider: metadata.provider,
    api: metadata.api,
    model: metadata.model,
    baseUrlHash: metadata.baseUrlHash,
    ...(metadata.sessionHash ? { sessionHash: metadata.sessionHash } : {}),
    ...(compactedOutput
      ? {
          compactedWindow: {
            state: "ready" as const,
            output: JSON.stringify(compactedOutput),
            ...(outputTokens !== undefined ? { outputTokens } : {}),
          },
        }
      : {}),
  } satisfies OpenAIResponsesCompactionReplayState;
  if (compactedOutput && !readOpenAIResponsesCompactionWindow(replay, model)) {
    throw new Error("Responses compact endpoint checkpoint is invalid or exceeds 16 MiB");
  }
  output.providerReplay = replay;
}

export function suppressOpenAIResponsesCompaction(
  output: Pick<AssistantMessage, "providerReplay">,
  model: Model,
  options?: Pick<BaseOpenAIStreamOptions, "onCompactionRejected" | "sessionId">,
  rejectedCheckpoint?: CompactionReplayRejection,
  itemRecovery?: string,
): void {
  const context = buildProviderReplayContext(model, options);
  if (!context.baseUrlHash) {
    return;
  }
  output.providerReplay = {
    v: 1,
    type: OPENAI_RESPONSES_COMPACTION_SUPPRESSION_TYPE,
    data: OPENAI_RESPONSES_COMPACTION_SUPPRESSION_DATA,
    ...context,
    baseUrlHash: context.baseUrlHash,
    ...(itemRecovery ? { itemRecovery } : {}),
  };
  if (rejectedCheckpoint) {
    options?.onCompactionRejected?.(rejectedCheckpoint);
  }
}

export function createCompactionTracker(
  output: Pick<AssistantMessage, "providerReplay">,
  model: Model,
  options?: { reasoningReplayMetadata?: OpenAIResponsesReasoningReplayMetadata },
) {
  const replayIndexes = new Map<string, number>();
  return {
    added(item: Pick<ResponseOutputItem, "type"> & { id?: string }, replayIndex: number): void {
      if (item.type === "compaction" && item.id) {
        replayIndexes.set(item.id, replayIndex);
      }
    },
    completed(
      item: Pick<ResponseOutputItem, "type"> & {
        id?: string;
        encrypted_content?: string | null;
      },
      fallbackReplayIndex: number,
    ): void {
      if (item.type !== "compaction" || !item.encrypted_content) {
        return;
      }
      captureOpenAIResponsesCompaction(
        output,
        {
          type: "compaction",
          ...(item.id ? { id: item.id } : {}),
          encrypted_content: item.encrypted_content,
        },
        (item.id ? replayIndexes.get(item.id) : undefined) ?? fallbackReplayIndex,
        model,
        options?.reasoningReplayMetadata,
      );
      if (item.id) {
        replayIndexes.delete(item.id);
      }
    },
  };
}

/** Keep immutable transport publication scoped to the host active when each row is read. */
function createOpenAIResponsesCompactionSourceReader(
  model: Model,
  options?: Pick<BaseOpenAIStreamOptions, "sessionId">,
) {
  return createCompactionSourceReader(model, options, () => getAiTransportHost().immutableData);
}

export function resolveNewestOpenAIResponsesCompactionReplay(
  messages: Context["messages"],
  model: Model,
  options?: Pick<BaseOpenAIStreamOptions, "sessionId">,
): (OpenAIResponsesCompactionSource & { owner: AssistantHistoryMessage }) | undefined {
  const read = createOpenAIResponsesCompactionSourceReader(model, options);
  const selected = resolveNewestCompactionReplaySource(messages, (message) =>
    message?.role === "assistant"
      ? read(message.providerReplay, message.content.length)
      : undefined,
  );
  if (!selected) {
    return undefined;
  }
  const owner = messages[selected.ownerIndex];
  return owner?.role === "assistant" ? { ...selected.source, owner } : undefined;
}

export type OpenAIResponsesReplayMode = "checkpoint" | "full-history" | { itemRecovery: string };

type OpenAIResponsesCompactionReplayPlan = {
  messages: Context["messages"];
  compactedWindow?: OpenAIResponsesCompactionOutput;
  compaction?: ResponseCompactionItemParam;
  preserveUnframedToolResults: boolean;
  itemRecovery?: { anchor: string };
};

export function buildOpenAIResponsesCompactionReplayPlan(
  messages: Context["messages"],
  model: Model,
  options?: Pick<BaseOpenAIStreamOptions, "sessionId"> & {
    mode?: OpenAIResponsesReplayMode;
  },
): OpenAIResponsesCompactionReplayPlan {
  if (typeof options?.mode === "object") {
    // Checkpoint rejection must rebuild from the untouched transcript; consulting
    // providerReplay here would recreate the same rejected compaction window.
    return {
      messages,
      preserveUnframedToolResults: false,
      itemRecovery: { anchor: options.mode.itemRecovery },
    };
  }
  const compaction = resolveNewestOpenAIResponsesCompactionReplay(messages, model, options);
  if (!compaction) {
    return { messages, preserveUnframedToolResults: false };
  }
  if (compaction.mode === "item-recovery") {
    const owner = compaction.owner;
    let replayMessages = messages;
    if (resolveFailedAssistantReplay(owner, { pairingAware: false }) === "drop") {
      // Keep a content-free boundary while normal transforms discard the failed output.
      const boundary: AssistantHistoryMessage = {
        role: "assistant",
        content: [],
        stopReason: "stop",
        api: owner.api,
        provider: owner.provider,
        model: owner.model,
        usage: owner.usage,
        timestamp: owner.timestamp,
        providerReplay: owner.providerReplay,
      };
      replayMessages = [...messages];
      replayMessages.splice(messages.indexOf(owner), 0, boundary);
    }
    return {
      messages: replayMessages,
      preserveUnframedToolResults: false,
      itemRecovery: { anchor: compaction.anchor },
    };
  }
  if (options?.mode === "full-history") {
    return { messages, preserveUnframedToolResults: false };
  }
  if (compaction.mode === "refresh-required") {
    throw new CompactionReplayRefreshRequiredError();
  }
  const ownerIndex = messages.indexOf(compaction.owner);
  const owner = {
    ...compaction.owner,
    content: compaction.owner.content.slice(compaction.replayIndex),
  };
  // Slice before transcript repair so compacted calls cannot synthesize outputs,
  // while real results emitted after the checkpoint remain in chronological order.
  return {
    messages: [owner, ...messages.slice(ownerIndex + 1)],
    ...(compaction.mode === "complete-window"
      ? { compactedWindow: compaction.output }
      : { compaction: compaction.item }),
    preserveUnframedToolResults: true,
  };
}

export function buildOpenAIResponsesReasoningReplayMetadata(
  model: Model,
  options?: Pick<BaseOpenAIStreamOptions, "sessionId">,
): OpenAIResponsesReasoningReplayMetadata {
  return {
    v: 1,
    source: "openai-responses",
    ...buildProviderReplayContext(model, options),
  };
}
