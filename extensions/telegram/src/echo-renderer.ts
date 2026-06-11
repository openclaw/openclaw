import type { Bot } from "grammy";
import {
  buildChannelProgressDraftLineForEntry,
  type ChannelProgressDraftLine,
  formatChannelProgressDraftText,
  mergeChannelProgressDraftLine,
  resolveChannelProgressDraftMaxLines,
  resolveChannelStreamingPreviewToolProgress,
} from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig, TelegramAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import type { GetReplyOptions } from "openclaw/plugin-sdk/reply-runtime";
import { resolveMarkdownTableMode } from "./bot-message-dispatch.runtime.js";
import type { TelegramThreadSpec } from "./bot/helpers.js";
import type { TelegramStreamMode } from "./bot/types.js";
import { createTelegramDraftStream } from "./draft-stream.js";
import { renderTelegramHtmlText } from "./format.js";

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
 * The renderer RIDES the destination account's own streaming config so the mirror
 * renders the turn exactly as that channel would have natively:
 *  - `streamMode: "progress"` with `preview.toolProgress` on → the tool-progress
 *    lane is shown (the same `🔧 tool …` draft lines the native compositor builds,
 *    via the shared `buildChannelProgressDraftLineForEntry`/`formatChannelProgressDraftText`),
 *    then collapses to the final answer — matching native progress-mode rendering.
 *  - `streamMode: "partial"` → just the streamed answer draft (native groups do not
 *    surface a separate tool lane in partial mode).
 * Reasoning/thinking lanes remain a follow-up; the resolver no-ops those callbacks.
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
  /** The destination account config — gates the lanes so the mirror rides its config. */
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

  // Tool-progress lane: ride the destination's config. Native only surfaces tool
  // progress in `progress` stream mode (the separate DM-only native draft aside),
  // so the mirror does the same — render the `🔧 tool …` lines into the single
  // evolving draft until the answer text arrives, then collapse to the answer.
  const showToolProgress =
    params.streamMode === "progress" &&
    resolveChannelStreamingPreviewToolProgress(params.streamingEntry);
  const progressMaxLines = resolveChannelProgressDraftMaxLines(params.streamingEntry);
  const progressSeed = `echo:${String(params.chatId)}:${params.thread?.id ?? ""}`;
  let progressLines: Array<string | ChannelProgressDraftLine> = [];

  let deltaAccumulator = "";
  let lastText: string | undefined;
  let pendingAnswer: string | undefined;
  let settled = false;

  const renderProgress = () => {
    if (!showToolProgress || progressLines.length === 0) {
      return;
    }
    const text = formatChannelProgressDraftText({
      entry: params.streamingEntry,
      lines: progressLines,
      seed: progressSeed,
    });
    if (text && text !== lastText) {
      lastText = text;
      answer.update(text);
      // Flush so the tool-progress lane is delivered as its own draft edit rather
      // than being throttle-coalesced with the final answer.
      void answer.flush?.();
    }
  };

  const pushProgress = (line: ChannelProgressDraftLine | undefined) => {
    if (!showToolProgress || !line) {
      return;
    }
    progressLines = mergeChannelProgressDraftLine(progressLines, line, {
      maxLines: progressMaxLines,
    });
    renderProgress();
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
      pendingAnswer = text;
      // In progress mode the tool-progress draft stays up for the whole turn and
      // collapses to the answer at finalize — matching native progress rendering,
      // where the answer does not pre-empt the tool lane mid-stream. In plain
      // streaming mode (no tool lane), stream the answer live.
      if (!showToolProgress) {
        lastText = text;
        answer.update(text);
      }
    },
    ...(showToolProgress
      ? {
          onToolStart: (payload) =>
            pushProgress(
              buildChannelProgressDraftLineForEntry(
                params.streamingEntry,
                {
                  event: "tool",
                  name: payload.name,
                  phase: payload.phase,
                  args: payload.args,
                  itemId: payload.itemId,
                  toolCallId: payload.toolCallId,
                },
                payload.detailMode ? { detailMode: payload.detailMode } : undefined,
              ),
            ),
          onItemEvent: (payload) =>
            pushProgress(
              buildChannelProgressDraftLineForEntry(params.streamingEntry, {
                event: "item",
                itemId: payload.itemId,
                itemKind: payload.kind,
                title: payload.title,
                name: payload.name,
                phase: payload.phase,
                status: payload.status,
                summary: payload.summary,
                progressText: payload.progressText,
                meta: payload.meta,
              }),
            ),
          onPlanUpdate: (payload) =>
            pushProgress(
              buildChannelProgressDraftLineForEntry(params.streamingEntry, {
                event: "plan",
                phase: payload.phase,
                title: payload.title,
                explanation: payload.explanation,
                steps: payload.steps,
              }),
            ),
          onCommandOutput: (payload) =>
            pushProgress(
              buildChannelProgressDraftLineForEntry(params.streamingEntry, {
                event: "command-output",
                itemId: payload.itemId,
                toolCallId: payload.toolCallId,
                name: payload.name,
                phase: payload.phase,
                title: payload.title,
                status: payload.status,
                exitCode: payload.exitCode,
              }),
            ),
          onPatchSummary: (payload) =>
            pushProgress(
              buildChannelProgressDraftLineForEntry(params.streamingEntry, {
                event: "patch",
                itemId: payload.itemId,
                toolCallId: payload.toolCallId,
                name: payload.name,
                phase: payload.phase,
                title: payload.title,
                added: payload.added,
                modified: payload.modified,
                deleted: payload.deleted,
                summary: payload.summary,
              }),
            ),
          onApprovalEvent: (payload) =>
            pushProgress(
              buildChannelProgressDraftLineForEntry(params.streamingEntry, {
                event: "approval",
                phase: payload.phase,
                title: payload.title,
                command: payload.command,
                reason: payload.reason,
                message: payload.message,
              }),
            ),
        }
      : {}),
  };

  const finalize = async (final?: ReplyPayload) => {
    if (settled) {
      return;
    }
    settled = true;
    const finalText =
      typeof final?.text === "string" ? final.text : (pendingAnswer ?? lastText);
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
    await (answer.discard?.() ?? answer.stop());
  };

  return { options, finalize, dispose };
}
