import type { AssistantMessage, ProviderReplayState } from "@openclaw/llm-core";

/** Undefined skips a row; null fences older checkpoints without selecting a source. */
export function resolveNewestCompactionReplaySource<T, S>(
  messages: readonly T[],
  read: (message: T) => S | null | undefined,
): { ownerIndex: number; source: S } | undefined {
  for (let ownerIndex = messages.length - 1; ownerIndex >= 0; ownerIndex -= 1) {
    const message = messages[ownerIndex];
    if (message === undefined) {
      continue;
    }
    const source = read(message);
    if (source !== undefined) {
      return source === null ? undefined : { ownerIndex, source };
    }
  }
  return undefined;
}

/** Content identities, not payloads, determine whether a covered prefix survives a rewrite. */
export function resolveCompactionReplayContentRewrite<T>(
  source: readonly T[],
  content: readonly T[],
  replayIndex: number,
  indexIsNumber = true,
): { type: "keep" } | { type: "strip" } | { type: "reindex"; replayIndex: number } {
  if ((content.length === 0 && source.length > 0) || replayIndex > source.length) {
    return { type: "strip" };
  }
  if (
    content.length === source.length &&
    content.slice(0, replayIndex).every((block, index) => block === source[index])
  ) {
    return { type: "keep" };
  }
  let sourceIndex = 0;
  let nextReplayIndex = 0;
  const unambiguous = content.every((block) => {
    const index = source.indexOf(block, sourceIndex);
    sourceIndex = index + 1;
    nextReplayIndex += index >= 0 && index < replayIndex ? 1 : 0;
    return index >= 0;
  });
  return !unambiguous
    ? { type: "strip" }
    : indexIsNumber && nextReplayIndex === replayIndex
      ? { type: "keep" }
      : { type: "reindex", replayIndex: nextReplayIndex };
}

/** Whether provider replay state is a prefix-bound server compaction checkpoint. */
export function isCompactionReplayCheckpoint(replay: unknown): replay is ProviderReplayState {
  const type =
    // SAFETY: This predicate inspects only the discriminator; payload validation stays with replay.
    replay && typeof replay === "object" ? (replay as { type?: unknown }).type : undefined;
  return (
    type === "anthropic-compaction" ||
    type === "openai-responses-compaction" ||
    type === "openai-responses-retained-compaction"
  );
}

/** Strip prefix-bound checkpoint state from an in-place message rewrite. */
export function stripCompactionReplayCheckpointInPlace(message: {
  providerReplay?: unknown;
}): void {
  if (isCompactionReplayCheckpoint(message.providerReplay)) {
    delete message.providerReplay;
  }
}

/** Strip prefix-bound checkpoints after local history rewrites. */
export function stripCompactionReplayCheckpoint(message: AssistantMessage): AssistantMessage {
  if (!isCompactionReplayCheckpoint(message.providerReplay)) {
    return message;
  }
  const replaySafeMessage = { ...message };
  delete replaySafeMessage.providerReplay;
  return replaySafeMessage;
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
