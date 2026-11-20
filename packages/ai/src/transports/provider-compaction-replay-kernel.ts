import type { AssistantMessage, Model, ProviderReplayState } from "@openclaw/llm-core";
import type { AiTransportHost } from "../host.js";
import { createAnthropicCompactionSourceReader } from "./anthropic-compaction-replay.js";
import {
  createOpenAIResponsesCompactionSourceReader,
  getOpenAIResponsesCompactionWindowReplayBytesAvailable,
} from "./openai-responses-compaction-checkpoint.js";
import { OPENAI_RESPONSES_APIS } from "./openai-responses-contracts.js";
import {
  isCompactionReplayCheckpoint,
  resolveCompactionReplayContentRewrite,
  resolveNewestCompactionReplaySource,
} from "./provider-compaction-checkpoint.js";

export type ReplayIdentity = { sessionId?: string; enabled?: boolean };
export type ReplayMessage = { role: string };

export function isAssistantReplayMessage<T extends ReplayMessage>(
  message: T,
): message is T & AssistantMessage {
  return message.role === "assistant";
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
export function createCompactionReplayWindowFactCollector(
  model: Model,
  identity: ReplayIdentity,
  resolveImmutableData?: () => AiTransportHost["immutableData"],
) {
  const responses = OPENAI_RESPONSES_APIS.has(model.api)
    ? createOpenAIResponsesCompactionSourceReader(model, identity, resolveImmutableData)
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
  resolveImmutableData?: () => AiTransportHost["immutableData"],
): T[] {
  const checkpoint = resolveCompactionReplayWindow(
    source,
    windowed,
    createCompactionReplayWindowFactCollector(model, identity, resolveImmutableData),
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
