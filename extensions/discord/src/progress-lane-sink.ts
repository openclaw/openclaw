/**
 * Discord sink for the shared progress-lane engine.
 *
 * Adapts the channel-neutral `ProgressLaneSink` contract onto Discord's existing
 * low-level draft stream (`createDiscordDraftStream`): the engine produces a
 * neutral body (a "Thinking" header, `[HH:MM:SS] tool` rows, the rolling timer),
 * which is already Discord-markdown-compatible, so `render` is identity. `update`
 * edits the durable progress message; `spill` rolls over to a continuation
 * message before the 2000-char cap so the stream never trips its oversize stop.
 *
 * This is additive: it drives the engine over the raw draft stream and does NOT
 * replace the line-based progress draft controller (#85200). A channel opts into
 * the shared engine via config; until then its existing renderer is untouched.
 */
import type { ProgressLaneSink } from "openclaw/plugin-sdk/progress-lane";
import { createDiscordDraftStream } from "./draft-stream.js";
import type { RequestClient } from "./internal/discord.js";

/** Discord messages cap at 2000 characters. */
const DISCORD_PROGRESS_MAX_CHARS = 2000;

/** The slice of the Discord draft stream the sink drives. */
type DraftStreamSeam = {
  update: (text: string) => void;
  forceNewMessage: () => void;
  flush: () => Promise<void>;
  stop: () => Promise<void>;
  clear: () => Promise<void>;
  messageId: () => string | undefined;
};

/** A `ProgressLaneSink` plus the lifecycle handles a channel's dispatch needs to
 * flush/seal/clear the durable message on finalize and cleanup. */
export interface DiscordProgressLaneSink extends ProgressLaneSink {
  flush(): Promise<void>;
  stop(): Promise<void>;
  clear(): Promise<void>;
  messageId(): string | undefined;
}

/**
 * Pure adapter over an existing draft stream — the testable seam. The engine's
 * neutral body is already Discord markdown, so `render` passes it through.
 */
export function discordProgressLaneSinkFromStream(
  stream: DraftStreamSeam,
  maxChars: number = DISCORD_PROGRESS_MAX_CHARS,
): DiscordProgressLaneSink {
  return {
    maxChars: Math.min(maxChars, DISCORD_PROGRESS_MAX_CHARS),
    render: (body) => body,
    update: (rendered) => stream.update(rendered),
    spill: () => stream.forceNewMessage(),
    flush: () => stream.flush(),
    stop: () => stream.stop(),
    clear: () => stream.clear(),
    messageId: () => stream.messageId(),
  };
}

/** Build a Discord progress-lane sink backed by a real draft stream. */
export function createDiscordProgressLaneSink(params: {
  rest: RequestClient;
  channelId: string;
  replyToMessageId?: string | (() => string | undefined);
  throttleMs?: number;
  suppressEmbeds?: boolean;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}): DiscordProgressLaneSink {
  const stream = createDiscordDraftStream({
    rest: params.rest,
    channelId: params.channelId,
    maxChars: DISCORD_PROGRESS_MAX_CHARS,
    minInitialChars: 0,
    suppressEmbeds: params.suppressEmbeds ?? true,
    throttleMs: params.throttleMs ?? 1200,
    ...(params.replyToMessageId !== undefined ? { replyToMessageId: params.replyToMessageId } : {}),
    ...(params.log ? { log: params.log } : {}),
    ...(params.warn ? { warn: params.warn } : {}),
  });
  return discordProgressLaneSinkFromStream(stream);
}
