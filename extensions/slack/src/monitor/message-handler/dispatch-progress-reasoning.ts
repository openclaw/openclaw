import type {
  ChannelProgressDraftCompositorSnapshot,
  ChannelProgressDraftLine,
} from "openclaw/plugin-sdk/channel-outbound";
import type { SlackAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createSlackReasoningCardState,
  formatReasoningSummaryTitle,
  planSlackReasoningCards,
  rolloverSlackReasoningCards,
  sealSlackReasoningCards,
  type SlackReasoningCardLine,
} from "../../progress-reasoning.js";
import { resolveSlackProgressReasoningMode } from "./dispatch-helpers.js";

// Every card is a compositor line, and the paced send reads the compositor's
// lines only when it fires. Admission is bounded to what the message being
// built can take, so at most one message's rows are unsent at any time; the
// compositor must still never evict them, and the default rolling window
// (eight lines) is smaller than one message's row budget. Cards mode
// therefore disables eviction; the budget, not the window, sizes a message.
const SLACK_REASONING_CARDS_WINDOW_LINES = Number.MAX_SAFE_INTEGER;

type ReasoningPayload = { text?: string; isReasoningSnapshot?: boolean };

type ReasoningCompositor = {
  mergeReasoningProgress: (text?: string, options?: { snapshot?: boolean }) => string;
  resetReasoningProgress: () => void;
  pushToolProgress: (
    line: ChannelProgressDraftLine,
    options?: { reasoningLine?: boolean },
  ) => Promise<boolean>;
  getSnapshot: () => Pick<ChannelProgressDraftCompositorSnapshot, "lines">;
};

/**
 * Reasoning outside progress mode: one rolling preview row. Tool admission
 * closes reasoning bursts, so the still-open lane is restored after it.
 */
export async function pushSlackReasoningPreview(
  compositor: ReasoningCompositor,
  payload: ReasoningPayload,
): Promise<boolean> {
  const normalized = compositor
    .mergeReasoningProgress(payload.text, { snapshot: payload.isReasoningSnapshot === true })
    .replace(/^_(.*)_$/su, "$1")
    .trim();
  if (!normalized) {
    return false;
  }
  const visible = await compositor.pushToolProgress({
    id: "reasoning",
    kind: "item",
    text: normalized,
    label: "Reasoning",
  });
  compositor.mergeReasoningProgress(normalized, { snapshot: true });
  return visible;
}

function withSlackReasoningCardsWindow(entry: SlackAccountConfig): SlackAccountConfig {
  return {
    ...entry,
    streaming: {
      ...entry.streaming,
      progress: { ...entry.streaming?.progress, maxLines: SLACK_REASONING_CARDS_WINDOW_LINES },
    },
  };
}

/**
 * Per-turn reasoning card state for the native progress card
 * (`streaming.progress.reasoning: "cards"`). Cards are ordinary compositor
 * lines, so they share the paced update loop, the start gate and the
 * reconciler with tool rows. The quiet card keeps one summary row and leaves
 * reasoning in the narration text.
 */
export function createSlackReasoningCardsRuntime(params: {
  entry: SlackAccountConfig;
  detailedNativeCard: boolean;
  compositor: () => ReasoningCompositor;
  /**
   * Whether the stream message being built can still take this row, rows
   * and bytes, on top of everything already admitted for it. Cards the
   * message cannot take wait in the runtime's queue until the chain rolls.
   */
  admits: (line: ChannelProgressDraftLine) => boolean;
  /**
   * Sends the chain until no card is queued, rolling to new messages as
   * needed. A tool row must not be admitted ahead of reasoning that came
   * before it, so a tool call flushes the queue first.
   */
  flushQueued: () => Promise<void>;
  /**
   * Cards were refused for room. Nothing reached the compositor, so nothing
   * else would schedule the paced send that rolls to a message with room.
   */
  noteQueued: () => void;
  now?: () => number;
}) {
  const enabled =
    params.detailedNativeCard && resolveSlackProgressReasoningMode(params.entry) === "cards";
  const now = params.now ?? Date.now;
  let state = createSlackReasoningCardState();
  // Last pushed status/text per card id, so unchanged cards are not re-admitted.
  // A planned card with no entry is queued: the message could not take it.
  let pushedKeys = new Map<string, string>();
  let startedAt: number | undefined;
  const cardKey = (line: SlackReasoningCardLine) => `${line.status ?? ""} ${line.text}`;
  // Cards the message refused for room in the last render, in order. Only
  // these are queued for the chain; a card a render has not reached yet is
  // not (a render can wait behind the send in flight).
  let queuedLines: SlackReasoningCardLine[] = [];
  const holdsLine = (id: string) =>
    params
      .compositor()
      .getSnapshot()
      .lines.some((line) => typeof line === "object" && line.id === id);

  // Admits planned cards in order: updates to admitted cards always (they
  // replace a row in place), new cards only while the message can take them,
  // and never a later card ahead of a queued earlier one. Rerun after the
  // chain rolled to release queued cards into the new message's room.
  // Undefined when the compositor refused a new card: the final reply started
  // and it takes no more lines, so the chain places the queue itself.
  const render = async (): Promise<boolean | undefined> => {
    let visible = false;
    const plan = planSlackReasoningCards(state);
    queuedLines = [];
    for (const [index, line] of plan.entries()) {
      const key = cardKey(line);
      const pushed = pushedKeys.get(line.id);
      if (pushed === key) {
        continue;
      }
      if (pushed === undefined && !params.admits(line)) {
        queuedLines = plan.slice(index).filter((later) => !pushedKeys.has(later.id));
        params.noteQueued();
        break;
      }
      pushedKeys.set(line.id, key);
      // The card is the reasoning's own row: admitting it must not close the
      // burst, or the compositor would lose the raw phase text (the space
      // that ends "Reading ", the tag a later delta closes) and every further
      // delta would merge against display text instead.
      visible =
        (await params.compositor().pushToolProgress(line, { reasoningLine: true })) || visible;
      if (pushed === undefined && !holdsLine(line.id)) {
        pushedKeys.delete(line.id);
        queuedLines = plan.slice(index).filter((later) => !pushedKeys.has(later.id));
        return undefined;
      }
    }
    return visible;
  };

  // Closes the open segment so later thinking starts a new card instead of
  // extending one that already sits above a tool row.
  const seal = async (): Promise<boolean> => {
    if (!enabled || !state.open) {
      return false;
    }
    sealSlackReasoningCards(state);
    params.compositor().resetReasoningProgress();
    return (await render()) === true;
  };

  return {
    enabled,
    compositorEntry: enabled ? withSlackReasoningCardsWindow(params.entry) : params.entry,
    reset() {
      state = createSlackReasoningCardState();
      pushedKeys = new Map();
      queuedLines = [];
      startedAt = undefined;
    },
    async push(payload: ReasoningPayload): Promise<boolean> {
      // The compositor keeps the raw phase text; only the rendered segments are normalized.
      const normalized = params.compositor().mergeReasoningProgress(payload.text, {
        snapshot: payload.isReasoningSnapshot === true,
      });
      if (!normalized) {
        return false;
      }
      startedAt ??= now();
      state.open = normalized;
      return (await render()) === true;
    },
    seal,
    async noteToolCall(): Promise<boolean> {
      if (!enabled) {
        return false;
      }
      state.toolCalls += 1;
      const visible = await seal();
      // The tool row follows the reasoning that preceded it. Cards the current
      // message could not take must reach their messages before the row is
      // admitted, or the row would sit above them.
      if (queuedLines.length > 0) {
        await params.flushQueued();
      }
      return visible;
    },
    /**
     * The message carrying cards up to `throughCard` is finished. Later text
     * of the same phase starts a new card on the next message; the merge
     * state is untouched so cumulative snapshots keep extending the phase.
     * Runs inside a stream send, so it must not push compositor lines.
     */
    rollover(throughCard: number): void {
      if (enabled) {
        rolloverSlackReasoningCards(state, throughCard);
      }
    },
    /** Cards the message being built refused for room. */
    pendingRows: (): number => queuedLines.length,
    /** Admits queued cards the message being built can take now. */
    release: async (): Promise<boolean | undefined> => (enabled ? await render() : false),
    /** The queued cards, in order, for a chain that must place them itself. */
    peekPendingLines: (): SlackReasoningCardLine[] => [...queuedLines],
    /** Cards the chain placed on a message without the compositor. */
    markPlaced(lineIds: Iterable<string>): void {
      const placed = new Set(lineIds);
      for (const line of queuedLines) {
        if (placed.has(line.id)) {
          pushedKeys.set(line.id, cardKey(line));
        }
      }
      queuedLines = queuedLines.filter((line) => !placed.has(line.id));
    },
    /** Completion headline for the think, once reasoning has streamed. */
    summaryTitle(): string | undefined {
      return enabled && startedAt !== undefined
        ? formatReasoningSummaryTitle({ elapsedMs: now() - startedAt, toolCalls: state.toolCalls })
        : undefined;
    },
  };
}
