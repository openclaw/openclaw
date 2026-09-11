import type { AnyChunk } from "@slack/types";
import type {
  ChannelProgressDraftCompositorSnapshot,
  ChannelProgressDraftLine,
} from "openclaw/plugin-sdk/channel-outbound";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { danger, logVerbose, warn } from "openclaw/plugin-sdk/runtime-env";
import { formatSlackError } from "../../errors.js";
import {
  buildSlackProgressStreamChunks,
  reconcileSlackNativeTaskChunks,
  resolveSlackNativeLineTaskId,
  resolveSlackReasoningTaskIndex,
  EMPTY_SLACK_NATIVE_STREAM_SNAPSHOT,
  type SlackNativeStreamSnapshot,
} from "../../progress-blocks.js";
import {
  SLACK_REASONING_CONTINUED_TITLE,
  SLACK_REASONING_ROLLED_TITLE,
  type SlackReasoningCardLine,
} from "../../progress-reasoning.js";
import { applyAppendOnlyStreamUpdate } from "../../stream-mode.js";
import { planSlackStreamUpdateFit, SlackStreamMessageLedger } from "../../stream-size.js";
import {
  discardSlackStreamPendingText,
  SlackStreamMessageTooLongError,
  type SlackStreamSession,
} from "../../streaming.js";
import type { createSlackNativeProgressTransport } from "./dispatch-progress-native.js";
import {
  resolveNativeProgressLines,
  resolveNativeProgressNarration,
} from "./dispatch-progress-render.js";
import {
  isSlackPlanStepTaskId,
  planSlackMessageOpening,
  planSlackMessageRetirement,
  resolveSlackCompletionPlanRows,
  resolveThawedSlackRows,
} from "./dispatch-progress-stream-rows.js";
import type { SlackDispatchSetup } from "./dispatch-setup.js";
import type { SlackStreamingDeliveryRuntime } from "./dispatch-streaming.js";

// Rounds a send may take beyond what its queued work needs (a roll and an
// append per row at worst): msg_too_long retries and empty rounds.
const SLACK_STREAM_ROLLOVER_BASE_ROUNDS = 4;
// Sends a drain may run before cards still queued are placed directly.
const SLACK_STREAM_DRAIN_PASSES = 3;

type SlackNativeStreamUpdate = { text?: string; chunks?: AnyChunk[] };

/** Outcome of one send: whether anything reached Slack and whether work remains queued. */
export type SlackNativeStreamSendResult = {
  sent: boolean;
  /** No card is queued and every row of the current draft is on a message. */
  settled: boolean;
};

type SlackStreamRollResult =
  | { rolled: false }
  | {
      rolled: true;
      /**
       * The closeout (new rows, narration) is on the finished message. False
       * means Slack rejected it: the content is still pending and goes to the
       * continuation.
       */
      closeoutDelivered: boolean;
    };

/**
 * The turn's native progress stream: what the current stream message holds
 * (task snapshot, narration text) and, in cards mode, the chain of messages a
 * long think rolls through. A message that would pass Slack's size or row cap
 * finishes as "continued below" and the turn goes on in a continuation in the
 * same thread with a fresh snapshot; no row id carries over.
 */
export function createSlackNativeProgressStream(params: {
  delivery: SlackStreamingDeliveryRuntime;
  transport: ReturnType<typeof createSlackNativeProgressTransport>;
  replyPlan: SlackDispatchSetup["replyPlan"];
  runtime: SlackDispatchSetup["runtime"];
  /** Roll to continuation messages instead of overfilling one (cards mode). */
  rollover: boolean;
  explicitTitle: string | undefined;
  maxLineChars: number;
  /** Quiet card: one summary row instead of a task per tool call. */
  summaryRow: boolean;
  getSnapshot: () => ChannelProgressDraftCompositorSnapshot;
  resolveTitle: (snapshot: ChannelProgressDraftCompositorSnapshot) => string | undefined;
  resolveCompletionTitle: (snapshot: ChannelProgressDraftCompositorSnapshot) => string | undefined;
  resolveSessionUrl: () => string | undefined;
  /** Cards through `throughCard` are on a finished message. */
  onRolled: (throughCard: number) => void;
  /** Cards the reasoning runtime holds back because the current message cannot take them. */
  pendingRows: () => number;
  /**
   * Admits queued cards the current message can take; the compositor snapshot
   * then holds them. Undefined when a release is not possible right now (a
   * compositor flush is waiting on this send): the next paced send retries.
   */
  releasePending: () => Promise<boolean | undefined>;
  /** Queued cards, for the last-resort path that places them without the compositor. */
  peekPendingLines: () => SlackReasoningCardLine[];
  markPendingPlaced: (lineIds: Iterable<string>) => void;
}) {
  const { delivery, transport, replyPlan, runtime } = params;
  // Plan title and task rows already delivered to the current stream message;
  // the reconciler diffs each snapshot against it and terminalizes ids that
  // drop out (plan shrinks, summary <-> plan source switches).
  let snapshot: SlackNativeStreamSnapshot = EMPTY_SLACK_NATIVE_STREAM_SNAPSHOT;
  let narrationRenderedText = "";
  let narrationSourceText = "";
  let completionSent = false;
  // Task ids delivered on earlier messages of this turn's chain.
  let rolledTaskIds = new Set<string>();
  // Running rows frozen on a message that overflowed, by task id, with the
  // rendered state they had then (title, status, details, output). They are
  // retired like delivered rows so continuations do not fill up with them
  // again, but a later result (a failure, output) changes that state and
  // thaws the row: it becomes eligible again and renders whole on the
  // current message with its result.
  let frozenRows = new Map<string, string>();
  // Plan rows a continuation shows: chosen when it opens, with capacity for
  // pending work held first; undefined on the first message (the whole plan)
  // and between messages. Steps shown on any message so far rank behind
  // steps not yet shown when the next continuation picks its plan rows.
  let messagePlanStepIds: Set<string> | undefined;
  let shownPlanStepIds = new Set<string>();
  let rolledMessages = 0;
  // Thread of the chain, so a continuation never takes another reply slot.
  let continuationThreadTs: string | undefined;

  const resolveNarrationUpdate = (incoming: string | undefined) => {
    const next = applyAppendOnlyStreamUpdate({
      incoming: incoming ?? "",
      rendered: narrationRenderedText,
      source: narrationSourceText,
    });
    return {
      next,
      delta: next.changed ? next.rendered.slice(narrationRenderedText.length) : "",
    };
  };

  const commitNarration = (next: ReturnType<typeof resolveNarrationUpdate>["next"]) => {
    if (next.changed) {
      narrationRenderedText = next.rendered;
      narrationSourceText = next.source;
    }
  };

  // Rows for the current message: rows already delivered on an earlier
  // message of the chain are filtered out before the headline is chosen
  // (lines with their own id) and again by task id (content-keyed lines).
  // Frozen rows whose rendered state moved on carry a result; let them through again.
  const thawChangedRows = (lines: readonly ChannelProgressDraftLine[]) => {
    if (frozenRows.size === 0) {
      return;
    }
    const thawed = resolveThawedSlackRows({
      lines,
      frozenRows,
      maxLineChars: params.maxLineChars,
      summaryRow: params.summaryRow,
    });
    for (const id of thawed) {
      frozenRows.delete(id);
      rolledTaskIds.delete(id);
    }
  };

  const resolveCurrentMessageLines = (draft: ChannelProgressDraftCompositorSnapshot) => {
    const lines = resolveNativeProgressLines(draft);
    thawChangedRows(lines);
    if (rolledTaskIds.size === 0) {
      return lines;
    }
    return lines.filter((line) => {
      const id = resolveSlackNativeLineTaskId(line);
      return !id || !rolledTaskIds.has(id);
    });
  };

  const buildCurrentMessageChunks = (build: {
    draft: ChannelProgressDraftCompositorSnapshot;
    title: string | undefined;
    finalInProgressStatus?: "complete" | "error";
    diffStat?: ChannelProgressDraftCompositorSnapshot["diffStat"];
    sessionUrl?: string;
  }): AnyChunk[] | undefined => {
    const chunks = buildSlackProgressStreamChunks({
      title: build.title,
      lines: resolveCurrentMessageLines(build.draft),
      plan: build.draft.plan,
      maxLineChars: params.maxLineChars,
      summaryRow: params.summaryRow,
      finalInProgressStatus: build.finalInProgressStatus,
      diffStat: build.diffStat,
      sessionUrl: build.sessionUrl,
      ...(rolledMessages > 0 ? { fallbackTitle: SLACK_REASONING_CONTINUED_TITLE } : {}),
    });
    const planStepIds = messagePlanStepIds;
    if (rolledTaskIds.size === 0 && !planStepIds) {
      return chunks;
    }
    return chunks?.filter(
      (chunk) =>
        chunk.type !== "task_update" ||
        (!rolledTaskIds.has(chunk.id) &&
          (!planStepIds || !isSlackPlanStepTaskId(chunk.id) || planStepIds.has(chunk.id))),
    );
  };

  /** Chunks for the queued cards, so an opening can hold room for them. */
  const pendingCardChunks = (): AnyChunk[] => {
    const lines = params.peekPendingLines();
    return lines.length === 0
      ? []
      : (buildSlackProgressStreamChunks({
          lines,
          maxLineChars: params.maxLineChars,
          summaryRow: params.summaryRow,
        }) ?? []);
  };

  /** Lets plan rows the continuation left out onto it for the closeout, as far as they fit. */
  const admitPlanForCompletion = (reserveText?: string) => {
    if (!messagePlanStepIds || !delivery.streamSession) {
      return;
    }
    const admitted = resolveSlackCompletionPlanRows({
      plan: params.getSnapshot().plan,
      planStepIds: messagePlanStepIds,
      shownPlanStepIds,
      ledger: delivery.streamLedger,
      ...(reserveText ? { reserveText } : {}),
      maxLineChars: params.maxLineChars,
      summaryRow: params.summaryRow,
    });
    for (const id of admitted) {
      messagePlanStepIds.add(id);
    }
  };

  const buildRunningChunks = (draft: ChannelProgressDraftCompositorSnapshot) =>
    buildCurrentMessageChunks({ draft, title: params.resolveTitle(draft) });

  const buildCompletionChunks = (finalInProgressStatus: "complete" | "error") => {
    const draft = params.getSnapshot();
    const lines = resolveCurrentMessageLines(draft);
    const sessionUrl = params.resolveSessionUrl();
    const narrationUpdate = resolveNarrationUpdate(resolveNativeProgressNarration(draft));
    const hasRetirableNativeTasks = [...snapshot.tasks.values()].some(
      (task) => task.status !== "complete" && task.status !== "error",
    );
    if (
      lines.length === 0 &&
      !draft.plan?.length &&
      !hasRetirableNativeTasks &&
      !draft.diffStat &&
      !narrationUpdate.delta &&
      !sessionUrl
    ) {
      return undefined;
    }
    const completion = reconcileSlackNativeTaskChunks({
      previous: snapshot,
      finalStatus: finalInProgressStatus,
      chunks: buildCurrentMessageChunks({
        draft,
        title:
          params.resolveCompletionTitle(draft) ??
          (lines.length === 0 && !draft.plan?.length ? "Working" : undefined),
        finalInProgressStatus,
        diffStat: draft.diffStat,
        sessionUrl,
      }),
    }).chunks;
    // Terminal appends, silent closeout, and queued rotation share this
    // snapshot: authored text still in the batch must reach the SDK before stop.
    return narrationUpdate.delta
      ? [{ type: "markdown_text" as const, text: narrationUpdate.delta }, ...(completion ?? [])]
      : completion;
  };

  const startOptions = () =>
    continuationThreadTs ? { threadTs: continuationThreadTs } : undefined;

  const reportFailure = (err: unknown) => {
    runtime.error?.(
      danger(`slack-stream: native progress stream failed: ${formatSlackError(err)}, falling back`),
    );
    delivery.streamFailed = true;
  };

  const forgetCurrentMessage = (session: SlackStreamSession) => {
    rolledMessages += 1;
    continuationThreadTs = session.threadTs;
    snapshot = EMPTY_SLACK_NATIVE_STREAM_SNAPSHOT;
    messagePlanStepIds = undefined;
    delivery.streamSession = null;
    delivery.nativeProgressStreamStartPromise = null;
  };

  /** Records what a finished message keeps (see planSlackMessageRetirement), then forgets it. */
  const retireMessage = (retire: {
    session: SlackStreamSession;
    previous: SlackNativeStreamSnapshot;
    full: AnyChunk[] | undefined;
    finished: SlackNativeStreamSnapshot;
    chunksRejected: boolean;
  }) => {
    const plan = planSlackMessageRetirement(retire);
    for (const id of plan.retiredTaskIds) {
      rolledTaskIds.add(id);
    }
    for (const id of (retire.chunksRejected ? retire.previous : retire.finished).tasks.keys()) {
      if (isSlackPlanStepTaskId(id)) {
        shownPlanStepIds.add(id);
      }
    }
    for (const [id, state] of plan.frozenRows) {
      frozenRows.set(id, state);
    }
    params.onRolled(plan.rolledThroughCard);
    forgetCurrentMessage(retire.session);
  };

  /**
   * The one place a message of the chain is started. Fits the opening under
   * a fresh message's budget: the text (or, for `reserveText`, room for text
   * the caller appends right after), then rows in order until the budget;
   * rows that do not fit stay where they are for the next round. Records
   * only what Slack accepted.
   */
  const openMessage = async (open: {
    chunks: AnyChunk[] | undefined;
    text?: string;
    reserveText?: string;
    /** Rows to hold room for that follow the opening (queued cards). */
    reserveFor?: AnyChunk[];
    finalStatus?: "complete" | "error";
  }): Promise<{
    accepted: boolean;
    textSent: boolean;
    admittedTaskIds: ReadonlySet<string>;
    /** Rows of the opening a fresh message could not take; they stay for the next round. */
    deferred: boolean;
  }> => {
    const planned = planSlackMessageOpening({
      ...open,
      continuation: rolledMessages > 0,
      shownPlanStepIds,
    });
    try {
      const accepted = await transport.start(planned.update, startOptions());
      if (!accepted) {
        return { accepted: false, textSent: false, admittedTaskIds: new Set(), deferred: false };
      }
    } catch (err) {
      reportFailure(err);
      return { accepted: false, textSent: false, admittedTaskIds: new Set(), deferred: false };
    }
    if (rolledMessages === 0) {
      replyPlan.markSent();
    }
    snapshot = planned.snapshot;
    messagePlanStepIds = planned.planStepIds;
    return {
      accepted: true,
      textSent: planned.textSent,
      admittedTaskIds: planned.admittedTaskIds,
      deferred: planned.deferred,
    };
  };

  /**
   * Finishes the current stream message as one that continues below: the
   * rows it holds plus the admitted new rows, every running row marked
   * complete, the rolled plan title, optional narration text. Not rolled
   * when the stop failed (delivery then leaves streaming) or Slack's Stop
   * cancelled the turn (nothing more is written).
   */
  const rollMessage = async (roll: {
    previous: SlackNativeStreamSnapshot;
    full: AnyChunk[] | undefined;
    admittedTaskIds: ReadonlySet<string>;
    text?: string;
    reason: string;
  }): Promise<SlackStreamRollResult> => {
    const session = delivery.streamSession;
    if (!session) {
      return { rolled: false };
    }
    const kept: AnyChunk[] = [
      { type: "plan_update", title: params.explicitTitle ?? SLACK_REASONING_ROLLED_TITLE },
    ];
    for (const chunk of roll.full ?? []) {
      if (
        chunk.type === "task_update" &&
        (roll.previous.tasks.has(chunk.id) || roll.admittedTaskIds.has(chunk.id))
      ) {
        kept.push(chunk.status === "in_progress" ? { ...chunk, status: "complete" } : chunk);
      }
    }
    const finish = reconcileSlackNativeTaskChunks({
      previous: roll.previous,
      finalStatus: "complete",
      chunks: kept,
    });
    const finishChunks: AnyChunk[] = [
      ...(roll.text ? [{ type: "markdown_text" as const, text: roll.text }] : []),
      ...(finish.chunks ?? []),
    ];
    const size = delivery.streamLedger.size;
    const rows = delivery.streamLedger.taskCount;
    const finished = await delivery.finishStream(
      finishChunks.length > 0 ? finishChunks : undefined,
    );
    if (delivery.streamFailed || delivery.isStoppedBySlack()) {
      return { rolled: false };
    }
    retireMessage({
      session,
      previous: roll.previous,
      full: roll.full,
      finished: finish.snapshot,
      chunksRejected: finished.chunksRejected,
    });
    logVerbose(
      `slack-stream: native progress message ${rolledMessages} rolled (${roll.reason}; ${size} weighted chars, ${rows} rows${finished.chunksRejected ? "; closeout rejected, carried over" : ""}); continuing in a new message`,
    );
    return { rolled: true, closeoutDelivered: !finished.chunksRejected };
  };

  /**
   * One paced send. Releases the cards the current message can still take,
   * sends the compositor against the message, and while cards stay queued
   * rolls to a continuation and goes on there; rows tool events admitted
   * past the budget roll the same way. A `msg_too_long` answer despite the
   * estimate rolls once and retries. Settled means nothing is queued and
   * every row of the draft is on a message.
   */
  const send = async (): Promise<SlackNativeStreamSendResult> => {
    if (delivery.isStoppedBySlack()) {
      return { sent: false, settled: true };
    }
    let sent = false;
    let tooLongRetried = false;
    // Bound from the work in hand: each queued card or unsent row needs at
    // most one roll and one append.
    const unsentRows = (buildRunningChunks(params.getSnapshot()) ?? []).filter(
      (chunk) => chunk.type === "task_update" && !snapshot.tasks.has(chunk.id),
    ).length;
    const maxRounds = SLACK_STREAM_ROLLOVER_BASE_ROUNDS + 2 * (params.pendingRows() + unsentRows);
    for (let round = 0; round < maxRounds; round += 1) {
      const released = params.rollover ? await params.releasePending() : false;
      const draft = params.getSnapshot();
      const narrationUpdate = resolveNarrationUpdate(resolveNativeProgressNarration(draft));
      let text = narrationUpdate.delta;
      const commitText = () => {
        commitNarration(narrationUpdate.next);
        text = "";
      };
      const hadSession = Boolean(delivery.streamSession);
      const previous = snapshot;
      const full = buildRunningChunks(draft);
      const reconciled = reconcileSlackNativeTaskChunks({ previous, chunks: full });
      const chunks = reconciled.chunks;
      const pending = params.rollover ? params.pendingRows() : 0;
      if (!chunks?.length && !text) {
        // Roll for queued cards only when this send could release them;
        // otherwise leave them to the next paced send.
        if (pending === 0 || !hadSession || released === undefined) {
          return { sent, settled: pending === 0 };
        }
        // Nothing more for this message and cards still queued: continue below.
        const roll = await rollMessage({
          previous,
          full,
          admittedTaskIds: new Set(),
          reason: "budget",
        });
        if (!roll.rolled) {
          return { sent, settled: false };
        }
        sent = true;
        continue;
      }
      const update: SlackNativeStreamUpdate = {
        ...(text ? { text } : {}),
        ...(chunks?.length ? { chunks } : {}),
      };
      if (!hadSession) {
        const opened = await openMessage({
          chunks: full,
          ...(text ? { text } : {}),
          reserveFor: pendingCardChunks(),
        });
        if (!opened.accepted) {
          return { sent, settled: false };
        }
        if (opened.textSent) {
          commitText();
        }
        sent = true;
        // Content arriving during the Slack call waits for the next paced
        // send; queued cards and rows the opening had to defer (tool or plan
        // rows the compositor admitted past a message) keep this one going.
        if (!params.rollover || (params.pendingRows() === 0 && !opened.deferred)) {
          return { sent: true, settled: true };
        }
        continue;
      }
      const fit = params.rollover
        ? planSlackStreamUpdateFit(delivery.streamLedger, update)
        : undefined;
      if (!fit || fit.fits) {
        try {
          const accepted = await transport.append(update);
          if (!accepted) {
            return { sent, settled: false };
          }
          // Commit transport identity and task state together. Buffered or failed
          // chunks must leave the identical render eligible for another attempt.
          commitText();
          if (chunks?.length) {
            snapshot = reconciled.snapshot;
          }
          sent = true;
          if (!params.rollover || params.pendingRows() === 0) {
            return { sent: true, settled: true };
          }
          continue;
        } catch (err) {
          if (params.rollover && !tooLongRetried && err instanceof SlackStreamMessageTooLongError) {
            tooLongRetried = true;
            runtime.log?.(
              warn(
                `slack-stream: Slack rejected a progress update with msg_too_long at ${delivery.streamLedger.size} weighted chars; continuing in a new message`,
              ),
            );
            // The SDK kept the rejected text; the rolled message's stop would
            // flush it there while `text` is sent again on the continuation.
            const rejectedSession = delivery.streamSession;
            if (rejectedSession) {
              discardSlackStreamPendingText(rejectedSession);
            }
            const roll = await rollMessage({
              previous,
              full,
              admittedTaskIds: new Set(),
              reason: "msg_too_long",
            });
            if (!roll.rolled) {
              return { sent, settled: false };
            }
            continue;
          }
          reportFailure(err);
          return { sent, settled: false };
        }
      }
      // Rows past the budget (tool or plan rows the compositor admitted on its
      // own): finish this message with the rows that fit and continue.
      const roll = await rollMessage({
        previous,
        full,
        admittedTaskIds: fit.admittedTaskIds,
        ...(fit.textFits && text ? { text } : {}),
        reason: "budget",
      });
      if (!roll.rolled) {
        return { sent, settled: false };
      }
      // Narration Slack rejected with the closeout stays pending for the continuation.
      if (fit.textFits && roll.closeoutDelivered) {
        commitText();
      }
      sent = true;
    }
    return { sent, settled: false };
  };

  /**
   * Finishes the current message as rolled and opens the continuation with
   * the rows that carry over and room for the text the caller appends next,
   * so streamed text can go on there. Used before narration that would not
   * fit and after Slack rejected narration.
   */
  const rollForNarration = async (
    reserveText: string,
    rejected?: SlackStreamSession,
  ): Promise<boolean> => {
    if (rejected) {
      discardSlackStreamPendingText(rejected);
    }
    const draft = params.getSnapshot();
    const roll = await rollMessage({
      previous: snapshot,
      full: buildRunningChunks(draft),
      admittedTaskIds: new Set(),
      reason: rejected ? "msg_too_long" : "budget",
    });
    if (!roll.rolled) {
      return false;
    }
    const opened = await openMessage({
      chunks: buildRunningChunks(draft),
      reserveText,
      reserveFor: pendingCardChunks(),
    });
    return opened.accepted;
  };

  /**
   * The answer would not fit under the think on this message. Close the
   * message as the finished think (its completion chunks and summary title)
   * and leave no session, so the answer streams as its own message in the
   * same thread. Also the retry path when Slack rejects the answer itself.
   */
  const finishBeforeAnswer = async (rejected?: SlackStreamSession): Promise<boolean> => {
    const session = delivery.streamSession;
    if (!session) {
      return false;
    }
    if (rejected) {
      discardSlackStreamPendingText(rejected);
    }
    const draft = params.getSnapshot();
    const completion = completionSent ? undefined : buildCompletionChunks("complete");
    const size = delivery.streamLedger.size;
    const finished = await delivery.finishStream(completion);
    if (delivery.streamFailed || delivery.isStoppedBySlack()) {
      return false;
    }
    if (completion?.length && finished.chunksRejected) {
      // The think's closeout did not land: the message closed without its
      // summary title, terminal rows and receipt. Continue the chain with a
      // message that carries them, so the answer streams under the finished
      // think as it would have here.
      retireMessage({
        session,
        previous: snapshot,
        full: buildRunningChunks(draft),
        finished: snapshot,
        chunksRejected: true,
      });
      const narrationUpdate = resolveNarrationUpdate(resolveNativeProgressNarration(draft));
      const opened = await openMessage({
        chunks: buildCurrentMessageChunks({
          draft,
          title: params.resolveCompletionTitle(draft) ?? SLACK_REASONING_CONTINUED_TITLE,
          finalInProgressStatus: "complete",
          diffStat: draft.diffStat,
          sessionUrl: params.resolveSessionUrl(),
        }),
        ...(narrationUpdate.delta ? { text: narrationUpdate.delta } : {}),
        finalStatus: "complete",
      });
      if (!opened.accepted) {
        return false;
      }
      if (opened.textSent) {
        commitNarration(narrationUpdate.next);
      }
      completionSent = true;
      logVerbose(
        `slack-stream: native progress message finished at ${size} weighted chars (${rejected ? "msg_too_long" : "budget"}); Slack rejected its closeout, carried to the message that streams the answer`,
      );
      return true;
    }
    if (completion?.length) {
      completionSent = true;
    }
    forgetCurrentMessage(session);
    logVerbose(
      `slack-stream: native progress message finished at ${size} weighted chars (${rejected ? "msg_too_long" : "budget"}); streaming the answer as a new message`,
    );
    return true;
  };

  /**
   * Last resort for cards still queued after sends settled nothing (the
   * compositor refused a release): place them straight from the queue on
   * budgeted messages, so no closeout carries them. The terminal reconcile
   * settles their status.
   */
  const placePendingRemainder = async (): Promise<void> => {
    let guard = params.pendingRows() + 1;
    while (
      params.pendingRows() > 0 &&
      guard-- > 0 &&
      !delivery.streamFailed &&
      !delivery.isStoppedBySlack()
    ) {
      const lines = params.peekPendingLines();
      const draft = params.getSnapshot();
      if (delivery.streamSession) {
        const roll = await rollMessage({
          previous: snapshot,
          full: buildRunningChunks(draft),
          admittedTaskIds: new Set(),
          reason: "budget",
        });
        if (!roll.rolled) {
          return;
        }
      }
      const opened = await openMessage({
        chunks: buildRunningChunks({ ...draft, lines: [...draft.lines, ...lines] }),
      });
      if (!opened.accepted) {
        return;
      }
      const placed: string[] = [];
      for (const id of opened.admittedTaskIds) {
        const card = resolveSlackReasoningTaskIndex(id);
        if (card !== undefined) {
          placed.push(`reasoning:${card}`);
        }
      }
      if (placed.length === 0) {
        return;
      }
      params.markPendingPlaced(placed);
    }
  };

  /**
   * Sends until nothing is queued: each pass sends the compositor and
   * releases queued cards, rolling as it goes, and ends unsettled only when
   * a start was not accepted or the compositor refused a release. Cards
   * still queued after the passes are placed straight from the queue on
   * budgeted messages, so no closeout ever carries them.
   */
  const drain = async (): Promise<void> => {
    if (!params.rollover || delivery.streamFailed || delivery.isStoppedBySlack()) {
      return;
    }
    for (let pass = 0; pass < SLACK_STREAM_DRAIN_PASSES; pass += 1) {
      const result = await send();
      if (result.settled || delivery.streamFailed || delivery.isStoppedBySlack()) {
        return;
      }
    }
    await placePendingRemainder();
  };

  return {
    get snapshot() {
      return snapshot;
    },
    get narrationRenderedText() {
      return narrationRenderedText;
    },
    get completionSent() {
      return completionSent;
    },
    set completionSent(value: boolean) {
      completionSent = value;
    },
    resolveNarrationUpdate,
    commitNarration,
    buildCompletionChunks,
    send,
    /** Per-turn reset: the next message starts a new chain. */
    reset() {
      snapshot = EMPTY_SLACK_NATIVE_STREAM_SNAPSHOT;
      narrationRenderedText = "";
      narrationSourceText = "";
      completionSent = false;
      rolledTaskIds = new Set();
      frozenRows = new Map();
      messagePlanStepIds = undefined;
      shownPlanStepIds = new Set();
      rolledMessages = 0;
      continuationThreadTs = undefined;
    },
    /** Makes room for streamed narration; false when the stream is lost. */
    async ensureRoomForNarration(delta: string): Promise<boolean> {
      if (
        !params.rollover ||
        !delivery.streamSession ||
        delivery.streamFailed ||
        planSlackStreamUpdateFit(delivery.streamLedger, { text: delta }).textFits
      ) {
        return true;
      }
      return await rollForNarration(delta);
    },
    retryNarrationOnNewMessage: async (rejected: SlackStreamSession): Promise<boolean> => {
      runtime.log?.(
        warn(
          `slack-stream: Slack rejected streamed text with msg_too_long at ${delivery.streamLedger.size} weighted chars; retrying in a new message`,
        ),
      );
      return await rollForNarration(rejected.pendingText, rejected);
    },
    /**
     * Whether the message being built can take one more row on top of the
     * rows already admitted for it (sent or not), rows and bytes.
     */
    admitsRow(line: ChannelProgressDraftLine): boolean {
      if (!params.rollover) {
        return true;
      }
      const draft = params.getSnapshot();
      const chunks = buildRunningChunks({ ...draft, lines: [...draft.lines, line] });
      return planSlackStreamUpdateFit(
        delivery.streamSession ? delivery.streamLedger : new SlackStreamMessageLedger(),
        { chunks },
      ).fits;
    },
    drain,
    admitPlanForCompletion,
    /**
     * Closeout (statuses, title, rows still queued behind the cancelled pacing
     * loop) and the answer share the message. When they would not fit, send
     * the queued rows first, rolling as needed; if the answer still does not
     * fit, finish the think here so the answer streams on its own.
     */
    async prepareForAnswer(payload: ReplyPayload): Promise<void> {
      if (!params.rollover || !delivery.streamSession || delivery.isStoppedBySlack()) {
        return;
      }
      const answerFits = () =>
        planSlackStreamUpdateFit(delivery.streamLedger, {
          text: `\n${resolveSendableOutboundReplyParts(payload).trimmedText}`,
          chunks: buildCompletionChunks("complete"),
        }).fits;
      // Queued cards go out first, whatever the answer needs; otherwise the
      // closeout and the answer share the message when they fit.
      if (params.pendingRows() > 0) {
        await drain();
      }
      admitPlanForCompletion(`\n${resolveSendableOutboundReplyParts(payload).trimmedText}`);
      if (!delivery.streamSession || delivery.streamFailed || answerFits()) {
        return;
      }
      await drain();
      admitPlanForCompletion(`\n${resolveSendableOutboundReplyParts(payload).trimmedText}`);
      if (delivery.streamSession && !delivery.streamFailed && !answerFits()) {
        await finishBeforeAnswer();
      }
    },
    retryAnswerOnNewMessage: async (rejected: SlackStreamSession): Promise<boolean> => {
      runtime.log?.(
        warn(
          `slack-stream: Slack rejected the answer with msg_too_long at ${delivery.streamLedger.size} weighted chars; retrying as a new message`,
        ),
      );
      return await finishBeforeAnswer(rejected);
    },
  };
}
