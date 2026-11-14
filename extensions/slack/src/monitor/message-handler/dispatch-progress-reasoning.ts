import {
  type ChannelProgressDraftLine,
  resolveChannelProgressDraftMaxLines,
} from "openclaw/plugin-sdk/channel-outbound";
import type { SlackAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createSlackReasoningCardState,
  formatReasoningSummaryTitle,
  planSlackReasoningCards,
  segmentReasoningText,
} from "../../progress-reasoning.js";

// Each card is one line in the compositor's rolling window. A burst of
// reasoning larger than the window would evict a card before the throttled
// stream sends it, so a turn that streams reasoning widens the window; rows
// that leave it later are already complete in Slack and stay there.
const SLACK_REASONING_CARDS_MIN_WINDOW_LINES = 64;

type ReasoningPayload = { text?: string; isReasoningSnapshot?: boolean };

type ReasoningCompositor = {
  mergeReasoningProgress: (text?: string, options?: { snapshot?: boolean }) => string;
  resetReasoningProgress: () => void;
  pushToolProgress: (
    line: ChannelProgressDraftLine,
    options?: { reasoningLine?: boolean },
  ) => Promise<boolean>;
};

/**
 * Reasoning outside progress mode: one rolling preview row, shown only with
 * tool progress previews. Each merge reprocesses the accumulated reasoning,
 * so a long stream with no preview to show it would block the event loop for
 * nothing. Tool admission closes reasoning bursts, so the still-open lane is
 * restored after it.
 */
export async function pushSlackReasoningPreview(
  compositor: ReasoningCompositor,
  payload: ReasoningPayload,
  previewEnabled: boolean,
): Promise<boolean> {
  if (!previewEnabled) {
    return false;
  }
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

// The window widens only once the turn streams reasoning (`widened`): the
// compositor reads maxLines on every merge, so a turn without reasoning keeps
// the configured window and renders its tool rows exactly as before.
function withSlackReasoningCardsWindow(
  entry: SlackAccountConfig,
  widened: () => boolean,
): SlackAccountConfig {
  if (resolveChannelProgressDraftMaxLines(entry) >= SLACK_REASONING_CARDS_MIN_WINDOW_LINES) {
    return entry;
  }
  const progress = entry.streaming?.progress;
  return {
    ...entry,
    streaming: {
      ...entry.streaming,
      progress: {
        ...progress,
        get maxLines() {
          return widened() ? SLACK_REASONING_CARDS_MIN_WINDOW_LINES : progress?.maxLines;
        },
      },
    },
  };
}

/**
 * Per-turn reasoning card state for the native progress card. Streamed
 * reasoning renders as task rows, interleaved with tool rows on the detailed
 * card and below the single summary row on the quiet card, which still shows
 * no tool rows. Cards are ordinary compositor lines, so they share the paced
 * update loop, the start gate and the reconciler with tool rows. A turn that
 * streams no reasoning renders exactly as before.
 */
export function createSlackReasoningCardsRuntime(params: {
  entry: SlackAccountConfig;
  nativeCard: boolean;
  /** The detailed card: tool rows show, and the finished card summarizes the think. */
  toolRows: boolean;
  compositor: () => ReasoningCompositor;
  now?: () => number;
}) {
  const enabled = params.nativeCard;
  const now = params.now ?? Date.now;
  let state = createSlackReasoningCardState();
  // Last pushed status/text per card id, so unchanged cards are not re-admitted.
  let pushedKeys = new Map<string, string>();
  let startedAt: number | undefined;

  const render = async (): Promise<boolean> => {
    const plan = planSlackReasoningCards(state);
    state.cardsEmitted = plan.cardsEmitted;
    let visible = false;
    for (const line of plan.lines) {
      const key = `${line.status ?? ""} ${line.text}`;
      if (pushedKeys.get(line.id) === key) {
        continue;
      }
      pushedKeys.set(line.id, key);
      // The card is the reasoning's own row: admitting it must not close the
      // burst, or the compositor would lose the raw phase text (the space
      // that ends "Reading ", the tag a later delta closes) and every further
      // delta would merge against display text instead.
      visible =
        (await params.compositor().pushToolProgress(line, { reasoningLine: true })) || visible;
    }
    return visible;
  };

  // Closes the open segment so later thinking starts a new card instead of
  // extending one that already sits above a tool row.
  const seal = async (): Promise<boolean> => {
    if (!enabled || !state.open) {
      return false;
    }
    state.sealed.push(...segmentReasoningText(state.open));
    state.open = "";
    params.compositor().resetReasoningProgress();
    return await render();
  };

  return {
    enabled,
    compositorEntry: enabled
      ? withSlackReasoningCardsWindow(params.entry, () => startedAt !== undefined)
      : params.entry,
    reset() {
      state = createSlackReasoningCardState();
      pushedKeys = new Map();
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
      return await render();
    },
    seal,
    async noteToolCall(): Promise<boolean> {
      if (!enabled) {
        return false;
      }
      state.toolCalls += 1;
      return await seal();
    },
    /**
     * Completion headline for the think, once reasoning has streamed. The
     * quiet card keeps its own headline.
     */
    summaryTitle(): string | undefined {
      return enabled && params.toolRows && startedAt !== undefined
        ? formatReasoningSummaryTitle({ elapsedMs: now() - startedAt, toolCalls: state.toolCalls })
        : undefined;
    },
  };
}
