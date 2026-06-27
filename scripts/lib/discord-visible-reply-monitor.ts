export type DiscordVisibleReplyAuthor = {
  id?: string;
  username?: string;
  global_name?: string | null;
  bot?: boolean;
};

export type DiscordVisibleReplyMessage = {
  id: string;
  timestamp?: string;
  content?: string;
  author?: DiscordVisibleReplyAuthor;
};

export type VisibleReplyGapStatus = "missing" | "late";

export type VisibleReplyGap = {
  promptId: string;
  promptTimestampMs: number;
  authorId?: string;
  authorName?: string;
  ageMs: number;
  thresholdMs: number;
  replyStatus: VisibleReplyGapStatus;
  replyId?: string;
  replyTimestampMs?: number;
  latencyMs?: number;
};

export type AnalyzeVisibleReplyGapsParams = {
  messages: readonly DiscordVisibleReplyMessage[];
  nowMs?: number;
  thresholdMs: number;
  botUserIds?: ReadonlySet<string>;
  promptAuthorIds?: ReadonlySet<string>;
};

export function analyzeVisibleReplyGaps(params: AnalyzeVisibleReplyGapsParams): VisibleReplyGap[] {
  const nowMs = params.nowMs ?? Date.now();
  const thresholdMs = Math.max(1, Math.floor(params.thresholdMs));
  const messages = [...params.messages]
    .map((message) => ({ message, timestampMs: parseDiscordTimestamp(message.timestamp) }))
    .filter((entry): entry is { message: DiscordVisibleReplyMessage; timestampMs: number } =>
      Number.isFinite(entry.timestampMs),
    )
    .toSorted(
      (a, b) =>
        a.timestampMs - b.timestampMs || compareDiscordSnowflake(a.message.id, b.message.id),
    );

  const gaps: VisibleReplyGap[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const { message, timestampMs } = messages[index]!;
    if (!isPromptCandidate(message, params.promptAuthorIds)) {
      continue;
    }
    const deadlineMs = timestampMs + thresholdMs;
    if (nowMs < deadlineMs) {
      continue;
    }
    const reply = messages
      .slice(index + 1)
      .find((entry) => isVisibleBotReply(entry.message, params.botUserIds));
    if (reply && reply.timestampMs <= deadlineMs) {
      continue;
    }
    gaps.push({
      promptId: message.id,
      promptTimestampMs: timestampMs,
      authorId: message.author?.id,
      authorName: message.author?.global_name ?? message.author?.username,
      ageMs: Math.max(0, nowMs - timestampMs),
      thresholdMs,
      replyStatus: reply ? "late" : "missing",
      ...(reply
        ? {
            replyId: reply.message.id,
            replyTimestampMs: reply.timestampMs,
            latencyMs: Math.max(0, reply.timestampMs - timestampMs),
          }
        : {}),
    });
  }
  return gaps;
}

export function formatVisibleReplyGapAlert(params: {
  channelId: string;
  gap: VisibleReplyGap;
}): string {
  const author = params.gap.authorName || params.gap.authorId || "a human";
  const threshold = formatDuration(params.gap.thresholdMs);
  const age = formatDuration(params.gap.ageMs);
  if (params.gap.replyStatus === "late") {
    const latency = formatDuration(params.gap.latencyMs ?? 0);
    return `⚠️ Discord visible-reply monitor: Fiducian replied after ${latency}, exceeding ${threshold}, for ${author}'s message ${params.gap.promptId} in channel ${params.channelId}. Check FAD-963/FAD-979 delivery suppression paths.`;
  }
  return `⚠️ Discord visible-reply monitor: no visible Fiducian reply within ${threshold} for ${author}'s message ${params.gap.promptId} in channel ${params.channelId} (age ${age}). Check FAD-963/FAD-979 delivery suppression paths.`;
}

export function filterUnalertedGaps(params: {
  gaps: readonly VisibleReplyGap[];
  alertedPromptIds: ReadonlySet<string>;
}): VisibleReplyGap[] {
  return params.gaps.filter((gap) => !params.alertedPromptIds.has(gap.promptId));
}

function isPromptCandidate(
  message: DiscordVisibleReplyMessage,
  promptAuthorIds: ReadonlySet<string> | undefined,
): boolean {
  if (!message.id || message.author?.bot === true) {
    return false;
  }
  if (promptAuthorIds?.size) {
    const authorId = message.author?.id;
    return Boolean(authorId && promptAuthorIds.has(authorId));
  }
  return true;
}

function isVisibleBotReply(
  message: DiscordVisibleReplyMessage,
  botUserIds: ReadonlySet<string> | undefined,
): boolean {
  if (!message.id) {
    return false;
  }
  const authorId = message.author?.id;
  if (botUserIds?.size) {
    return Boolean(authorId && botUserIds.has(authorId));
  }
  return message.author?.bot === true;
}

function parseDiscordTimestamp(timestamp: string | undefined): number {
  if (!timestamp) {
    return Number.NaN;
  }
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function compareDiscordSnowflake(a: string, b: string): number {
  try {
    const left = BigInt(a);
    const right = BigInt(b);
    return left < right ? -1 : left > right ? 1 : 0;
  } catch {
    return a.localeCompare(b);
  }
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.round(minutes / 60);
  return `${hours}h`;
}
