import type { AssistantMessage, Context, Model, ProviderReplayState } from "@openclaw/llm-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  createAnthropicCompactionSourceReader,
  resolveNewestAnthropicCompaction,
} from "./anthropic-compaction-replay.js";
import { resolveAnthropicServerCompactionPlan } from "./anthropic-payload-policy.js";
import {
  CompactionReplayRefreshRequiredError,
  createOpenAIResponsesCompactionSourceReader,
  resolveNewestOpenAIResponsesCompactionReplay,
} from "./openai-responses-compaction-replay.js";
import { getOpenAIResponsesCompactionWindowReplayBytesAvailable } from "./openai-responses-compaction-window.js";
import { resolveResponsesContextUsageBoundary } from "./openai-responses-context-usage.js";
import { OPENAI_RESPONSES_APIS } from "./openai-responses-contracts.js";
import {
  isCompactionReplayCheckpoint,
  resolveCompactionReplayContentRewrite,
  resolveNewestCompactionReplaySource,
  stripCompactionReplayCheckpoint,
} from "./provider-compaction-checkpoint.js";

export {
  isCompactionReplayCheckpoint,
  resolveCompactionReplayContentRewrite,
  stripCompactionReplayCheckpoint,
  stripCompactionReplayCheckpointInPlace,
} from "./provider-compaction-checkpoint.js";

export {
  CompactionReplayRefreshRequiredError,
  readOpenAIResponsesItemRecoveryAnchor,
} from "./openai-responses-compaction-replay.js";

type ReplayIdentity = { sessionId?: string; enabled?: boolean };
type ReplayMessage = { role: string };
type ReplayPressureEstimator = {
  text(value: string): number;
  image(): number;
  json(value: unknown): number;
  toolResult?(value: string): number;
};

function isAssistantReplayMessage<T extends ReplayMessage>(
  message: T,
): message is T & AssistantMessage {
  return message.role === "assistant";
}

/** Resolve from prepared transport facts; never retain or return credential material. */
export function resolveCompactionReplayEligibility(
  model: Model,
  options: { extraParams?: Record<string, unknown>; apiKey?: string },
): boolean {
  if (OPENAI_RESPONSES_APIS.has(model.api)) {
    return true;
  }
  return (
    Boolean(options.apiKey?.trim()) &&
    resolveAnthropicServerCompactionPlan(model, options.extraParams, options.apiKey).enabled
  );
}

function resolveCompactionSource<T extends ReplayMessage>(
  messages: readonly T[],
  model: Model,
  identity: ReplayIdentity,
) {
  if (identity.enabled === false) {
    return undefined;
  }
  const assistants = messages.filter(isAssistantReplayMessage);
  const selected = (() => {
    if (OPENAI_RESPONSES_APIS.has(model.api)) {
      const responses = resolveNewestOpenAIResponsesCompactionReplay(assistants, model, identity);
      return responses && responses.mode !== "item-recovery"
        ? { family: "responses" as const, ...responses }
        : undefined;
    }
    if (identity.enabled !== true) {
      return undefined;
    }
    const anthropic = resolveNewestAnthropicCompaction(assistants, model, identity);
    return anthropic ? { family: "anthropic" as const, ...anthropic } : undefined;
  })();
  if (!selected) {
    return undefined;
  }
  const owner = assistants.find((message) => message === selected.owner);
  return owner ? { ...selected, owner } : undefined;
}

/** Manual recovery uses the durable client compactor, never a guessed retained-user prefix. */
export function requiresCompactionReplayRefresh(
  messages: readonly ReplayMessage[],
  model: Model,
  identity: ReplayIdentity,
): boolean {
  const checkpoint = resolveCompactionSource(messages, model, identity);
  return checkpoint?.family === "responses" && checkpoint.mode === "refresh-required";
}

type CompactionReplayWindowMode =
  | "barrier"
  | "anthropic"
  | "compacted-prefix"
  | "complete-window"
  | "refresh-required";

/** A payload-free decision for one normalized row, scoped to its collector's model/session. */
export type CompactionReplayWindowFact = {
  mode: CompactionReplayWindowMode;
  rewrite?:
    | { retained: true }
    | {
        retained: false;
        replayIndex: number;
        indexIsNumber: boolean;
        reindexedMode: CompactionReplayWindowMode;
        /** Bytes available for a replacement index in a validated Responses window. */
        replayIndexBytes?: number;
      };
};

/** Validate while the row is alive; neither the returned fact nor this reader retains payloads. */
export function createCompactionReplayWindowFactCollector(model: Model, identity: ReplayIdentity) {
  const responses = OPENAI_RESPONSES_APIS.has(model.api)
    ? createOpenAIResponsesCompactionSourceReader(model, identity)
    : undefined;
  const anthropic =
    !responses && identity.enabled === true
      ? createAnthropicCompactionSourceReader(model, identity)
      : undefined;
  const readMode = (
    replay: ProviderReplayState | undefined,
    contentLength: number,
  ): CompactionReplayWindowMode | undefined => {
    if (responses) {
      const source = responses(replay, contentLength);
      return source === undefined
        ? undefined
        : source === null || source.mode === "item-recovery"
          ? "barrier"
          : source.mode;
    }
    const source = anthropic?.(replay);
    return source === undefined ? undefined : source === null ? "barrier" : "anthropic";
  };
  return (message: ReplayMessage): CompactionReplayWindowFact | undefined => {
    if (identity.enabled === false || !isAssistantReplayMessage(message)) {
      return undefined;
    }
    const replay = message.providerReplay;
    const mode = readMode(replay, message.content.length);
    if (mode === undefined) {
      return undefined;
    }
    if (!isCompactionReplayCheckpoint(replay)) {
      return { mode };
    }
    if (replay.type === "openai-responses-retained-compaction") {
      return { mode, rewrite: { retained: true } };
    }
    // A content rewrite can repair an invalid index. Resolve that envelope with
    // the same provider reader now, while its opaque checkpoint is still alive.
    const reindexed = { ...replay, replayIndex: 0 };
    const reindexedMode = readMode(reindexed, message.content.length) ?? "barrier";
    const index: unknown = Reflect.get(replay, "replayIndex") ?? 0;
    return {
      mode,
      rewrite: {
        retained: false,
        replayIndex: Number(index),
        indexIsNumber: typeof index === "number",
        reindexedMode,
        ...(responses && reindexedMode === "complete-window"
          ? {
              replayIndexBytes:
                getOpenAIResponsesCompactionWindowReplayBytesAvailable(reindexed) + 1,
            }
          : {}),
      },
    };
  };
}

/** Use payload-free block identities with the same rewrite decision as the message adapter. */
export function replaceCompactionReplayWindowFactContent<T>(
  fact: CompactionReplayWindowFact | undefined,
  source: readonly T[],
  content: readonly T[],
): CompactionReplayWindowFact | undefined {
  const rewrite = fact?.rewrite;
  if (!rewrite || rewrite.retained) {
    return fact;
  }
  const result = resolveCompactionReplayContentRewrite(
    source,
    content,
    rewrite.replayIndex,
    rewrite.indexIsNumber,
  );
  if (result.type === "strip") {
    return undefined;
  }
  if (result.type === "keep") {
    return fact;
  }
  return {
    mode:
      rewrite.replayIndexBytes !== undefined &&
      String(result.replayIndex).length > rewrite.replayIndexBytes
        ? "refresh-required"
        : rewrite.reindexedMode,
    rewrite: { ...rewrite, replayIndex: result.replayIndex, indexIsNumber: true },
  };
}

/** Shared history projection; projectedFact describes the empty-content owner to prepend. */
export function resolveCompactionReplayWindow<T>(
  source: readonly T[],
  windowed: readonly T[],
  readFact: (message: T) => CompactionReplayWindowFact | undefined,
): { ownerIndex: number; projectedFact: CompactionReplayWindowFact; suffix: T[] } | undefined {
  const checkpoint = resolveNewestCompactionReplaySource(source, (message) => {
    const fact = readFact(message);
    return fact?.mode === "barrier" ? null : fact;
  });
  if (!checkpoint) {
    return undefined;
  }
  const owner = source[checkpoint.ownerIndex];
  if (owner === undefined || windowed.includes(owner)) {
    return undefined;
  }
  const ownerIndex = source.indexOf(owner);
  const fact = checkpoint.source;
  const rewrite = fact.rewrite;
  // Reference membership intentionally matches history limiters that keep a leading prelude.
  const suffix = new Set(source.slice(ownerIndex + 1));
  return {
    ownerIndex,
    projectedFact:
      rewrite && !rewrite.retained
        ? {
            mode: rewrite.reindexedMode,
            rewrite: { ...rewrite, replayIndex: 0, indexIsNumber: true },
          }
        : fact,
    suffix: windowed.filter((message) => suffix.has(message)),
  };
}

/** Carry a checkpoint immediately after reference-preserving history limiting, before repair. */
export function preserveCompactionReplayWindow<T extends ReplayMessage>(
  source: readonly T[],
  windowed: T[],
  model: Model,
  identity: ReplayIdentity,
): T[] {
  const checkpoint = resolveCompactionReplayWindow(
    source,
    windowed,
    createCompactionReplayWindowFactCollector(model, identity),
  );
  if (!checkpoint) {
    return windowed;
  }
  const owner = source[checkpoint.ownerIndex];
  if (owner === undefined || !isAssistantReplayMessage(owner)) {
    return windowed;
  }
  const replay = owner.providerReplay;
  // Retained-user state has no content index, including its refresh-required barrier.
  const providerReplay = checkpoint.projectedFact.rewrite?.retained
    ? replay
    : { ...replay, replayIndex: 0 };
  return [{ ...owner, content: [], providerReplay }, ...checkpoint.suffix];
}

function estimateResponsesContent(
  content: unknown,
  estimate: ReplayPressureEstimator,
  text: (value: string) => number,
): number {
  if (typeof content === "string") {
    return text(content);
  }
  if (!Array.isArray(content)) {
    return estimate.json(content);
  }
  return content.reduce<number>((tokens, block: unknown) => {
    if (!isRecord(block)) {
      return tokens + estimate.json(block);
    }
    if (
      (block.type === "input_text" || block.type === "output_text") &&
      typeof block.text === "string"
    ) {
      const { text: value, ...metadata } = block;
      return tokens + text(value) + estimate.json(metadata);
    }
    if (block.type === "input_image") {
      const { image_url: url, ...metadata } = block;
      return (
        tokens +
        estimate.image() +
        estimate.json(typeof url === "string" && url.startsWith("data:") ? metadata : block)
      );
    }
    return tokens + estimate.json(block);
  }, 0);
}

function estimateResponsesInput(
  input: readonly unknown[],
  estimate: ReplayPressureEstimator,
  compactionOutputTokens?: number,
): number {
  return input.reduce<number>((tokens, entry) => {
    if (!isRecord(entry)) {
      return tokens + estimate.json(entry);
    }
    if (entry.type === "compaction" && typeof entry.encrypted_content === "string") {
      const { encrypted_content, ...metadata } = entry;
      return (
        tokens +
        (compactionOutputTokens ?? estimate.text(encrypted_content)) +
        estimate.json(metadata)
      );
    }
    if (entry.type === "message") {
      const { content, ...metadata } = entry;
      return (
        tokens +
        estimate.json(metadata) +
        estimateResponsesContent(content, estimate, (value) => estimate.text(value))
      );
    }
    if (entry.type === "function_call_output" || entry.type === "custom_tool_call_output") {
      const { output, ...metadata } = entry;
      return (
        tokens +
        estimate.json(metadata) +
        estimateResponsesContent(output, estimate, (value) =>
          estimate.toolResult ? estimate.toolResult(value) : estimate.text(value),
        )
      );
    }
    return tokens + estimate.json(entry);
  }, 0);
}

/** Estimate the canonical prefix and its tail once, independent of unbound usage snapshots. */
export function resolveCompactionReplayPressure<T extends ReplayMessage>(
  messages: T[],
  model: Model,
  identity: ReplayIdentity,
  estimate: ReplayPressureEstimator,
  systemPrompt?: string,
  requestContext?: Context,
): { messages: T[]; prefixTokens: number; measuredTokens?: number } | undefined {
  const checkpoint = resolveCompactionSource(messages, model, identity);
  if (!checkpoint) {
    return undefined;
  }
  if (checkpoint.family === "responses" && checkpoint.mode === "refresh-required") {
    throw new CompactionReplayRefreshRequiredError();
  }
  const ownerIndex = messages.findIndex((message) => message === checkpoint.owner);
  const owner = messages[ownerIndex];
  if (!owner) {
    return undefined;
  }
  const prefixTokens =
    checkpoint.family === "anthropic"
      ? estimate.text(checkpoint.summary)
      : checkpoint.mode === "complete-window"
        ? estimateResponsesInput(checkpoint.output, estimate, checkpoint.outputTokens)
        : estimate.text(checkpoint.item.encrypted_content);
  const measuredBoundary =
    checkpoint.family === "responses"
      ? resolveResponsesContextUsageBoundary(
          messages,
          model,
          identity,
          systemPrompt,
          requestContext,
        )
      : undefined;
  if (measuredBoundary) {
    // Async tool results can be persisted before the final usage event. The wire
    // owner orders them after its response; count that suffix instead of a raw index.
    return {
      messages: [],
      prefixTokens:
        measuredBoundary.totalTokens + estimateResponsesInput(measuredBoundary.suffix, estimate),
      measuredTokens: measuredBoundary.totalTokens,
    };
  }
  // The checkpoint-producing request predates its replacement window. Later usage
  // is authoritative only when its saved wire prefix still matches this replay.
  const { contextUsage: _staleContextUsage, ...usage } = checkpoint.owner.usage;
  const tail: T[] = [];
  for (const message of messages.slice(ownerIndex + 1)) {
    if (!isAssistantReplayMessage(message) || message.usage.contextUsage === undefined) {
      tail.push(message);
      continue;
    }
    const { contextUsage: _unboundContextUsage, ...billedUsage } = message.usage;
    tail.push({ ...message, usage: billedUsage });
  }
  return {
    messages: [
      { ...owner, content: checkpoint.owner.content.slice(checkpoint.replayIndex), usage },
      ...tail,
    ],
    prefixTokens,
  };
}

/** Preserve the covered prefix and reindex checkpoints after known content removals. */
export function replaceCompactionReplayOwnerContent(
  message: AssistantMessage,
  content: AssistantMessage["content"],
): AssistantMessage {
  const next = { ...message, content };
  const replay = message.providerReplay;
  if (!isCompactionReplayCheckpoint(replay)) {
    return next;
  }
  if (replay.type === "openai-responses-retained-compaction") {
    // This checkpoint is anchored to retained user turns, not assistant content indexes.
    return next;
  }
  const replayIndex = replay.replayIndex ?? 0;
  const rewrite = resolveCompactionReplayContentRewrite(message.content, content, replayIndex);
  if (rewrite.type === "strip") {
    return stripCompactionReplayCheckpoint(next);
  }
  return rewrite.type === "keep"
    ? next
    : { ...next, providerReplay: { ...replay, replayIndex: rewrite.replayIndex } };
}
