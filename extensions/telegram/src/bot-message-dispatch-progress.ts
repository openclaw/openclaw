import {
  createChannelProgressDraftCompositor,
  createLivePreviewLifecycle,
  createPreviewMessageReceipt,
  resolveChannelProgressDraftMaxLineChars,
  resolveChannelProgressDraftMaxLines,
  type ChannelProgressDraftLine,
} from "openclaw/plugin-sdk/channel-outbound";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import type { TelegramBotDeps } from "./bot-deps.js";
import { deliverFallback } from "./bot-message-dispatch-delivery.js";
import {
  enqueueDraftEvent,
  prepareAnswerLaneForToolProgress,
  retireAnswerLane,
  rotateAnswerLaneForNewMessage,
} from "./bot-message-dispatch-draft.js";
import type {
  TelegramDispatchTurn as Turn,
  TelegramDispatchTurnConfig as TurnConfig,
  TelegramProgressStateSlice,
} from "./bot-message-dispatch.types.js";
import type { DraftLaneState } from "./lane-delivery-text-deliverer.js";
import { renderTelegramProgressDraftPreview } from "./progress-draft-preview.js";
import { editMessageTelegram } from "./send.js";

type BufferedDispatchParams = Parameters<
  TelegramBotDeps["dispatchReplyWithBufferedBlockDispatcher"]
>[0];
type ReplyOptions = NonNullable<BufferedDispatchParams["replyOptions"]>;
type CallbackPayload<K extends keyof ReplyOptions> =
  NonNullable<ReplyOptions[K]> extends (...args: infer Args) => unknown ? Args[0] : never;

function buildTelegramThinkingProgressLine(progressTokens: number): ChannelProgressDraftLine {
  const label = `Thinking… (~${Math.round(progressTokens)} tokens)`;
  return {
    id: "reasoning:token-progress",
    kind: "item",
    icon: "🧠",
    label,
    text: `🧠 ${label}`,
    prefix: false,
  };
}

function buildTelegramTextToolProgressLine(text: string, id?: string): ChannelProgressDraftLine {
  return {
    ...(id ? { id } : {}),
    kind: "item",
    label: "",
    text,
    prefix: false,
  };
}

type TelegramProgressDraftState = {
  answerLane: DraftLaneState;
  reasoningLane: DraftLaneState;
  streamReasoningInProgressDraft: boolean;
};

const TELEGRAM_COMPACTION_PROGRESS_ID = "context-compaction";

function buildTelegramCompactionProgressLine(
  phase: "start" | "complete" | "incomplete",
): ChannelProgressDraftLine {
  const label = {
    start: "Compacting context...",
    complete: "Compaction complete",
    incomplete: "Compaction incomplete",
  }[phase];
  return {
    id: TELEGRAM_COMPACTION_PROGRESS_ID,
    kind: "item",
    icon: "🧹",
    label,
    text: `🧹 ${label}`,
    prefix: false,
  };
}

export function createProgressState(
  config: TurnConfig,
  draftState: TelegramProgressDraftState,
  getTurn: () => Turn,
): TelegramProgressStateSlice {
  const progressCompositor = createChannelProgressDraftCompositor({
    preparedItems: true,
    entry: config.telegramCfg,
    mode: config.streamMode,
    active: Boolean(draftState.answerLane.stream),
    seed: `${config.context.route.accountId}:${config.context.chatId}:${config.context.threadSpec.id ?? ""}`,
    reasoningGate: draftState.streamReasoningInProgressDraft,
    reasoningLinePrefix: "🧠 ",
    commentaryLinePrefix: "💬 ",
    commentaryItalics: false,
    updateOnLineChange: true,
    shouldStartNow: (line) => typeof line !== "string" && Boolean(line?.toolName),
    update: async (streamText, options) => {
      await prepareAnswerLaneForToolProgress(getTurn());
      draftState.answerLane.lastPartialText = streamText;
      draftState.answerLane.hasStreamedMessage = true;
      draftState.answerLane.finalized = false;
      draftState.answerLane.stream?.updatePreview(
        renderTelegramProgressDraftPreview(options.snapshot, {
          toolProgress: progressCompositor.previewToolProgressEnabled,
          richMessages: config.telegramCfg.richMessages === true,
          maxLines: resolveChannelProgressDraftMaxLines(config.telegramCfg),
          maxLineChars: resolveChannelProgressDraftMaxLineChars(config.telegramCfg),
        }),
      );
      if (options.flush) {
        await draftState.answerLane.stream?.flush();
      }
    },
    deleteCurrent: async () => await retireAnswerLane(getTurn(), "clear"),
  });
  const draftLanes = [draftState.answerLane, draftState.reasoningLane];
  const previewLifecycle = createLivePreviewLifecycle<ReplyPayload, number>({
    draft: draftLanes.some((lane) => lane.stream)
      ? {
          flush: async () => {
            for (const lane of draftLanes) {
              await lane.stream?.flush();
            }
          },
          id: () =>
            draftState.answerLane.stream?.messageId() ??
            draftState.reasoningLane.stream?.messageId(),
          discardPending: async () => {
            for (const lane of draftLanes) {
              await lane.stream?.discard();
            }
          },
          clear: async () => {
            for (const lane of draftLanes) {
              // Accepted blocks and pagination pages have physical custody independent
              // of whether this turn's final answer succeeded.
              if (!lane.finalized) {
                await lane.stream?.clear();
              }
            }
          },
        }
      : undefined,
    cleanupUndelivered: true,
    onFinalStarted: () => progressCompositor.markFinalReplyStarted(),
    onFinalDelivered: () => progressCompositor.markFinalReplyDelivered(),
    onCleanupFailure: (error) =>
      config.runtime.error?.(`telegram preview cleanup failed: ${formatErrorMessage(error)}`),
  });
  return {
    verboseProgressActive: () => false,
    progressCompositor,
    previewLifecycle,
    commentaryProgressEnabled: progressCompositor.commentaryProgressEnabled,
    progressPreambleEnabled:
      config.streamMode === "progress" && draftState.answerLane.stream ? true : undefined,
  };
}

export async function settleFailedFinalDelivery(turn: Turn): Promise<void> {
  if (
    turn.isSuperseded() ||
    turn.previewLifecycle.finalSucceeded ||
    turn.progressContinuationAdopted ||
    turn.context.ctxPayload.InboundEventKind === "room_event" ||
    !turn.previewLifecycle.finalFailed
  ) {
    return;
  }
  const text =
    "I couldn't confirm the reply reached Telegram. Check OpenClaw chat history for the answer before retrying the task.";
  const stream = turn.answerLane.stream;
  const messageId = stream?.messageId();
  if (
    turn.previewLifecycle.finalDelivered ||
    !stream ||
    typeof messageId !== "number" ||
    !Number.isFinite(messageId) ||
    turn.answerLane.finalized
  ) {
    await deliverFallback(
      turn,
      [{ text, isError: true }],
      turn.telegramCfg.silentErrorReplies === true,
    );
    return;
  }
  try {
    await stream.discard();
    if (turn.isSuperseded()) {
      return;
    }
    await (turn.telegramDeps.editMessageTelegram ?? editMessageTelegram)(
      turn.context.chatId,
      messageId,
      text,
      {
        api: turn.bot.api,
        cfg: turn.cfg,
        accountId: turn.context.route.accountId,
        linkPreview: turn.telegramCfg.linkPreview,
      },
    );
    turn.answerLane.finalized = true;
    turn.deliveryState.markDelivered();
    await turn.previewLifecycle.observeDelivery(
      {
        visibleReplySent: true,
        receipt: createPreviewMessageReceipt({ id: messageId }),
        content: text,
      },
      { isError: true },
    );
  } catch (error) {
    // An unavailable transport cannot terminalize the card. Keep its last visible
    // progress instead of replacing unknown final custody with a duplicate send.
    turn.runtime.error?.(`telegram failed preview settlement: ${formatErrorMessage(error)}`);
  }
}

export function canPushToolProgress(turn: Turn): boolean {
  return Boolean(
    turn.answerLane.stream &&
    !turn.verboseProgressActive() &&
    !turn.answerLane.finalized &&
    !turn.previewLifecycle.finalStarted,
  );
}

function canPushCompactionProgress(turn: Turn): boolean {
  return Boolean(
    turn.answerLane.stream && !turn.answerLane.finalized && !turn.previewLifecycle.finalStarted,
  );
}

async function pushProgressEvent(turn: Turn, event: () => Promise<boolean>): Promise<boolean> {
  return canPushToolProgress(turn) ? await event() : false;
}

export async function pushToolProgress(
  turn: Turn,
  line?: string | ChannelProgressDraftLine,
  options?: { toolName?: string; startImmediately?: boolean; id?: string },
): Promise<boolean> {
  if (!canPushToolProgress(turn)) {
    return false;
  }
  // Structured rows own detail; formatted callbacks only fill a missing keyed row.
  if (
    options?.id &&
    turn.progressCompositor
      .getSnapshot()
      .lines.some((entry) => typeof entry === "object" && entry.id === options.id)
  ) {
    return true;
  }
  return await turn.progressCompositor.pushToolProgress(
    typeof line === "string" ? buildTelegramTextToolProgressLine(line, options?.id) : line,
    options,
  );
}

export async function pushReasoningProgress(
  turn: Turn,
  payload: { text?: string; isReasoningSnapshot?: boolean },
): Promise<boolean> {
  return await turn.progressCompositor.pushReasoningProgress(payload.text, {
    snapshot: payload.isReasoningSnapshot === true,
  });
}

export async function pushThinkingTokenProgress(
  turn: Turn,
  progressTokens: number,
): Promise<boolean> {
  return await pushToolProgress(turn, buildTelegramThinkingProgressLine(progressTokens), {
    startImmediately: true,
  });
}

export async function handleToolStart(
  turn: Turn,
  payload: CallbackPayload<"onToolStart">,
): Promise<boolean> {
  const toolName = payload.name?.trim();
  const progressPromise = pushProgressEvent(turn, () =>
    turn.progressCompositor.pushToolEvent(payload),
  );
  if (turn.statusReactionController && toolName) {
    await turn.statusReactionController.setTool(toolName);
  }
  return await progressPromise;
}

export async function handleCompactionStart(turn: Turn): Promise<boolean> {
  const progress = canPushCompactionProgress(turn)
    ? turn.progressCompositor.pushToolProgress(buildTelegramCompactionProgressLine("start"), {
        startImmediately: true,
        flush: true,
      })
    : Promise.resolve(false);
  await turn.statusReactionController?.setCompacting();
  return await progress;
}

export async function handleCompactionEnd(
  turn: Turn,
  payload?: CallbackPayload<"onCompactionEnd">,
): Promise<boolean> {
  const progress = canPushCompactionProgress(turn)
    ? turn.progressCompositor.pushToolProgress(
        buildTelegramCompactionProgressLine(
          payload?.completed === false ? "incomplete" : "complete",
        ),
        { startImmediately: true, flush: true },
      )
    : Promise.resolve(false);
  turn.statusReactionController?.cancelPending();
  await turn.statusReactionController?.setThinking();
  return await progress;
}

export async function handleItemEvent(
  turn: Turn,
  payload: CallbackPayload<"onItemEvent">,
): Promise<boolean> {
  let rendered = false;
  await enqueueDraftEvent(turn, async () => {
    if (turn.previewLifecycle.finalStarted) {
      return;
    }
    if (
      payload.phase === "start" &&
      payload.kind === "tool" &&
      turn.answerLane.stream &&
      turn.streamMode !== "progress" &&
      !turn.activeAnswerDraftIsToolProgressOnly
    ) {
      // A new operation invalidates unaccepted answer text before its progress can render.
      await rotateAnswerLaneForNewMessage(turn);
      turn.progressCompositor.resetActivity();
    }
    rendered =
      payload.kind === "preamble"
        ? await turn.progressCompositor.pushItemEvent(payload)
        : await pushProgressEvent(turn, () => turn.progressCompositor.pushItemEvent(payload));
  });
  return rendered;
}

export async function handlePlanUpdate(
  turn: Turn,
  payload: CallbackPayload<"onPlanUpdate">,
): Promise<boolean> {
  return payload.phase === "update" && canPushToolProgress(turn)
    ? await turn.progressCompositor.pushPlanProgress(payload.steps, {
        explanation: payload.explanation,
        explanationFormat: payload.explanationFormat,
      })
    : false;
}

export async function handleApprovalEvent(
  turn: Turn,
  payload: CallbackPayload<"onApprovalEvent">,
): Promise<boolean> {
  return await pushProgressEvent(turn, () => turn.progressCompositor.pushApprovalEvent(payload));
}
