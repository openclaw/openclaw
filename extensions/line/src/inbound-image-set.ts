import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { enqueueKeyedTask } from "openclaw/plugin-sdk/keyed-async-queue";

// LINE sends each image separately, sometimes without index or total. Unlike
// createInboundDebouncer, this buffer groups by sender/set but serializes by chat,
// starts the gap timer after entering the lane, and retains live ingress adoption.
// The timer bounds gaps between parts, not the whole upload or time spent queued.
const IMAGE_SET_FLUSH_DELAY_MS = 4_000;

type PendingImageSetPart<TEvent, TLifecycle> = {
  index?: number;
  arrivedAt: number;
  event: TEvent;
  lifecycle: TLifecycle;
};

type PendingImageSet<TEvent, TLifecycle> = {
  // Keyed by message id so a redelivered event replaces its part instead of
  // adding a duplicate image to the turn.
  parts: Map<string, PendingImageSetPart<TEvent, TLifecycle>>;
  total?: number;
  release: () => void;
  timer?: ReturnType<typeof setTimeout>;
};

type LineImageSetDelivery<TEvent, TLifecycle> = {
  events: readonly TEvent[];
  lifecycles: readonly TLifecycle[];
  /** Announced parts still missing when the wait expires. */
  missing?: number;
  /** Release after delivery, so later messages cannot overtake media preparation. */
  finish: () => void;
};

// Unindexed parts sort last; choosing index/arrival per pair is not transitive.
function orderedParts<TEvent, TLifecycle>(
  pending: PendingImageSet<TEvent, TLifecycle>,
): readonly PendingImageSetPart<TEvent, TLifecycle>[] {
  return [...pending.parts.values()].toSorted(
    (left, right) =>
      (left.index ?? Number.MAX_SAFE_INTEGER) - (right.index ?? Number.MAX_SAFE_INTEGER) ||
      left.arrivedAt - right.arrivedAt,
  );
}

// The first part holds admission open until the set completes or expires.
// Returning every part early would leave no live adoption for the combined turn.
export function createLineImageSetIngressBuffer<TEvent, TLifecycle>() {
  // Sender separates group members' parts: the turn is authorized only for its holder.
  const pendingBySet = new Map<string, PendingImageSet<TEvent, TLifecycle>>();
  // Carry distinct delivered ids across partial sets to avoid double-counting redelivery.
  // Expiry, restart, or completion drops this bounded carry; late parts may then
  // over-report missing images. A failed partial turn can under-report them.
  const deliveredBySet = new Map<
    string,
    { messageIds: Set<string>; timer?: ReturnType<typeof setTimeout> }
  >();
  const pendingKey = (laneKey: string, senderKey: string, setId: string) =>
    `${laneKey}\u0000${senderKey}\u0000${setId}`;
  const laneChain = new Map<string, Promise<void>>();

  // Deferred image sets and ordinary messages share one queue. Hold its slot
  // until delivery finishes, not merely until the image-set wait finishes.
  const enterLane = async (laneKey: string): Promise<() => void> => {
    const { promise: held, resolve: release } = createDeferred<void>();
    const { promise: turn, resolve: entered } = createDeferred<void>();
    void enqueueKeyedTask({
      tails: laneChain,
      key: laneKey,
      task: async () => {
        entered();
        await held;
      },
    });
    await turn;
    return release;
  };

  const admit = async (input: {
    laneKey: string;
    setId: string;
    senderKey: string;
    messageId: string;
    index?: number;
    total?: number;
    event: TEvent;
    lifecycle: TLifecycle;
  }): Promise<LineImageSetDelivery<TEvent, TLifecycle> | null> => {
    const part: PendingImageSetPart<TEvent, TLifecycle> = {
      index: input.index,
      arrivedAt: Date.now(),
      event: input.event,
      lifecycle: input.lifecycle,
    };

    const key = pendingKey(input.laneKey, input.senderKey, input.setId);
    const forming = pendingBySet.get(key);
    if (forming) {
      forming.parts.set(input.messageId, part);
      // A later part may carry the total an earlier one omitted.
      forming.total ??= input.total;
      if (forming.total !== undefined && forming.parts.size >= forming.total) {
        forming.release();
        return null;
      }
      // Reset only a running timer: queued time must not consume the gap budget.
      if (forming.timer) {
        clearTimeout(forming.timer);
        forming.timer = setTimeout(forming.release, IMAGE_SET_FLUSH_DELAY_MS);
        forming.timer.unref?.();
      }
      return null;
    }

    const { promise: whole, resolve: release } = createDeferred<void>();
    const pending: PendingImageSet<TEvent, TLifecycle> = {
      parts: new Map([[input.messageId, part]]),
      total: input.total,
      release: () => {
        clearTimeout(pending.timer);
        release();
      },
    };
    pendingBySet.set(key, pending);
    const carried = deliveredBySet.get(key);
    if (carried) {
      clearTimeout(carried.timer);
      deliveredBySet.delete(key);
    }
    const carriedMessageIds = carried?.messageIds ?? new Set<string>();
    const releaseLane = await enterLane(input.laneKey);
    // The wait starts here, not on arrival: time spent queued behind earlier work
    // on this lane is not time LINE spent delivering the rest of the set.
    pending.timer = setTimeout(pending.release, IMAGE_SET_FLUSH_DELAY_MS);
    pending.timer.unref?.();
    if (pending.total !== undefined && pending.parts.size >= pending.total) {
      pending.release();
    }
    await whole;
    // These parts are the turn. A part arriving after this starts its own set and
    // queues behind this delivery rather than joining a snapshot it missed.
    pendingBySet.delete(key);
    const ordered = orderedParts(pending);
    const deliveredMessageIds = new Set([...carriedMessageIds, ...pending.parts.keys()]);
    const missing = pending.total === undefined ? 0 : pending.total - deliveredMessageIds.size;
    if (missing > 0) {
      const carry: { messageIds: Set<string>; timer?: ReturnType<typeof setTimeout> } = {
        messageIds: deliveredMessageIds,
      };
      carry.timer = setTimeout(() => deliveredBySet.delete(key), IMAGE_SET_FLUSH_DELAY_MS * 5);
      carry.timer.unref?.();
      deliveredBySet.set(key, carry);
    }
    return {
      events: ordered.map((entry) => entry.event),
      lifecycles: ordered.map((entry) => entry.lifecycle),
      ...(missing > 0 ? { missing } : {}),
      finish: releaseLane,
    };
  };

  return { admit, enterLane, isBusy: (laneKey: string) => laneChain.has(laneKey) };
}
