import type { Bot } from "grammy";
import {
  type ChannelProgressDraftLine,
  createChannelProgressDraftCompositor,
} from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig, TelegramAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import type { GetReplyOptions } from "openclaw/plugin-sdk/reply-runtime";
import { resolveMarkdownTableMode } from "./bot-message-dispatch.runtime.js";
import type { TelegramThreadSpec } from "./bot/helpers.js";
import type { TelegramStreamMode } from "./bot/types.js";
import { createTelegramDraftStream } from "./draft-stream.js";
import { renderTelegramHtmlText } from "./format.js";
import { buildTelegramProgressCallbacks } from "./streaming-progress-callbacks.js";

const TELEGRAM_DRAFT_MAX_CHARS = 4096;

/**
 * B-full native streaming echo — the Telegram render target.
 *
 * Given a target chat, builds a live-edited draft (createTelegramDraftStream — the
 * SAME primitive the native inbound compositor uses, with the same markdown→HTML
 * render + table mode) and exposes it as a GetReplyOptions callback bundle. Driven
 * by the mirror reply resolver (echo-mirror-resolver.ts), it streams the origin
 * run's response onto the target chat as a native, live-edited message — without
 * re-running the agent and without going through the inbound dispatch pipeline
 * (so no admission, persistence, or message:sent hook → loop-safe by construction).
 *
 * The renderer RIDES the destination account's streaming config by reusing the
 * exact same code the native inbound dispatch uses — NOT a parallel reimplementation:
 *  - tool/commentary/plan/etc progress flows through `buildTelegramProgressCallbacks`
 *    (the shared callback bundle factored out of the native dispatch), and
 *  - that funnels into `createChannelProgressDraftCompositor`, the shared compositor
 *    that owns all `streaming.preview.toolProgress` / `streaming.progress.*` gating.
 * So whatever a native reply in this channel would render for a given config — the
 * inline preview tool lane in `partial`, the durable progress draft + commentary in
 * `progress` — the mirror renders the same, because it is the same code.
 */
export type TelegramEchoRenderer = {
  /** Hand to the mirror resolver so it drives the draft from the origin run. */
  options: GetReplyOptions;
  /** Flush the streamed draft into its final state (call when the origin run ends). */
  finalize: (final?: ReplyPayload) => Promise<void>;
  /** Abort without finalizing (origin turn aborted); stops the draft loop. */
  dispose: () => Promise<void>;
};

export function createTelegramEchoRenderer(params: {
  api: Bot["api"];
  chatId: Parameters<Bot["api"]["sendMessage"]>[0];
  thread?: TelegramThreadSpec | null;
  cfg: OpenClawConfig;
  accountId?: string;
  /** The destination account config — the compositor rides its streaming config. */
  streamingEntry?: TelegramAccountConfig;
  /** Resolved stream mode of the destination account (off is filtered upstream). */
  streamMode?: TelegramStreamMode;
  /** Per-account text limit (native dispatch passes this; draft caps at 4096). */
  textLimit: number;
  throttleMs?: number;
  log?: (message: string) => void;
}): TelegramEchoRenderer {
  const tableMode = resolveMarkdownTableMode({
    cfg: params.cfg,
    channel: "telegram",
    accountId: params.accountId,
  });
  const renderText = (text: string) => ({
    text: renderTelegramHtmlText(text, { tableMode }),
    parseMode: "HTML" as const,
  });

  const answer = createTelegramDraftStream({
    api: params.api,
    chatId: params.chatId,
    maxChars: Math.min(params.textLimit, TELEGRAM_DRAFT_MAX_CHARS),
    thread: params.thread ?? undefined,
    renderText,
    ...(params.throttleMs ? { throttleMs: params.throttleMs } : {}),
    log: params.log,
    warn: params.log,
  });

  let lastText: string | undefined;
  let deltaAccumulator = "";
  let finalStarted = false;
  let settled = false;

  // Reuse the native streaming progress compositor: it renders the progress lines
  // into our single echo draft and owns every config gate (preview.toolProgress,
  // progress mode, commentary). The `update` callback is the only echo-specific bit.
  const progressDraft = createChannelProgressDraftCompositor({
    entry: params.streamingEntry,
    mode: params.streamMode ?? "partial",
    active: true,
    seed: `echo:${String(params.chatId)}:${params.thread?.id ?? ""}`,
    update: (text, options) => {
      lastText = text;
      answer.update(text);
      return options?.flush ? answer.flush() : undefined;
    },
  });

  const pushToolProgress = (
    line?: string | ChannelProgressDraftLine,
    options?: { toolName?: string; startImmediately?: boolean },
  ) => {
    if (finalStarted || settled) {
      return false;
    }
    return progressDraft.pushToolProgress(line, options);
  };

  const options: GetReplyOptions = {
    onPartialReply: (payload) => {
      // The resolver forwards cumulative `text` (embedded/CLI); fall back to
      // accumulating raw deltas for delta-only producers.
      const text =
        typeof payload.text === "string"
          ? payload.text
          : payload.delta
            ? ((deltaAccumulator += payload.delta), deltaAccumulator)
            : undefined;
      if (text === undefined) {
        return;
      }
      // First answer chunk: tell the compositor the final reply has begun so it
      // stops pushing progress, then the answer text takes over the draft.
      if (!finalStarted) {
        finalStarted = true;
        progressDraft.markFinalReplyStarted();
      }
      lastText = text;
      answer.update(text);
    },
    onReasoningStream: async (payload) => {
      if (finalStarted || settled) {
        return;
      }
      await progressDraft.pushReasoningProgress(
        typeof payload.text === "string" ? payload.text : undefined,
      );
    },
    // Tool / item / plan / approval / command / patch / compaction progress — the
    // exact same wiring the native dispatch uses (no duplication).
    ...buildTelegramProgressCallbacks({
      entry: params.streamingEntry,
      pushToolProgress,
      pushCommentaryProgress: (text, opts) => progressDraft.pushCommentaryProgress(text, opts),
    }),
  };

  const finalize = async (final?: ReplyPayload) => {
    if (settled) {
      return;
    }
    settled = true;
    progressDraft.markFinalReplyDelivered();
    const finalText = typeof final?.text === "string" ? final.text : lastText;
    if (finalText !== undefined && finalText !== lastText) {
      answer.update(finalText);
    }
    await answer.stop();
  };

  const dispose = async () => {
    if (settled) {
      return;
    }
    settled = true;
    progressDraft.cancel();
    await (answer.discard?.() ?? answer.stop());
  };

  return { options, finalize, dispose };
}
