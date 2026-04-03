import { type QueueDropPolicy, type QueueMode } from "../auto-reply/reply/queue.js";
import { defaultRuntime } from "../runtime.js";
import { renderDeferredBatch } from "../utils/deferred-render.js";
import {
  type DeferredDisplayPayload,
  type DeferredExecutionPayload,
} from "../utils/deferred-visibility.js";
import {
  type DeliveryContext,
  deliveryContextKey,
  normalizeDeliveryContext,
} from "../utils/delivery-context.js";
import {
  applyQueueRuntimeSettings,
  applyQueueDropPolicy,
  beginQueueDrain,
  clearQueueSummaryState,
  drainCollectQueueStep,
  drainNextQueueItem,
  hasCrossChannelItems,
  previewQueueSummaryPrompt,
  waitForQueueDebounce,
} from "../utils/queue-helpers.js";
import type { AgentInternalEvent } from "./internal-events.js";

export type AnnounceQueueItem = {
  // Stable announce identity shared by direct + queued delivery paths.
  // Optional for backward compatibility with previously queued items.
  announceId?: string;
  execution: DeferredExecutionPayload;
  display: DeferredDisplayPayload;
  internalEvents?: AgentInternalEvent[];
  enqueuedAt: number;
  sessionKey: string;
  origin?: DeliveryContext;
  originKey?: string;
  sourceSessionKey?: string;
  sourceChannel?: string;
  sourceTool?: string;
};

export type AnnounceQueueSettings = {
  mode: QueueMode;
  debounceMs?: number;
  cap?: number;
  dropPolicy?: QueueDropPolicy;
};

type AnnounceQueueState = {
  items: AnnounceQueueItem[];
  draining: boolean;
  lastEnqueuedAt: number;
  mode: QueueMode;
  debounceMs: number;
  cap: number;
  dropPolicy: QueueDropPolicy;
  droppedCount: number;
  summaryLines: string[];
  collectForceIndividual: boolean;
  send: (item: AnnounceQueueItem) => Promise<void>;
  /** Safe queued announce item shape to reuse for overflow-summary delivery when items drain empty. */
  lastSummaryTarget?: AnnounceQueueItem;
  /** Latest dropped-item target when summarized drops still belong to one origin. */
  summaryOverflowTarget?: AnnounceQueueItem;
  /** Origin key for summarized drops; null means mixed/ambiguous and unsafe to route. */
  summaryOverflowOriginKey?: string | null;
  /** Consecutive drain failures — drives exponential backoff on errors. */
  consecutiveFailures: number;
};

const ANNOUNCE_QUEUES = new Map<string, AnnounceQueueState>();

export function resetAnnounceQueuesForTests() {
  // Test isolation: other suites may leave a draining queue behind in the worker.
  // Clearing the map alone isn't enough because drain loops capture `queue` by reference.
  for (const queue of ANNOUNCE_QUEUES.values()) {
    queue.items.length = 0;
    queue.summaryLines.length = 0;
    queue.droppedCount = 0;
    queue.lastEnqueuedAt = 0;
  }
  ANNOUNCE_QUEUES.clear();
}

function getAnnounceQueue(
  key: string,
  settings: AnnounceQueueSettings,
  send: (item: AnnounceQueueItem) => Promise<void>,
) {
  const existing = ANNOUNCE_QUEUES.get(key);
  if (existing) {
    applyQueueRuntimeSettings({
      target: existing,
      settings,
    });
    existing.send = send;
    return existing;
  }
  const created: AnnounceQueueState = {
    items: [],
    draining: false,
    lastEnqueuedAt: 0,
    mode: settings.mode,
    debounceMs: typeof settings.debounceMs === "number" ? Math.max(0, settings.debounceMs) : 1000,
    cap: typeof settings.cap === "number" && settings.cap > 0 ? Math.floor(settings.cap) : 20,
    dropPolicy: settings.dropPolicy ?? "summarize",
    droppedCount: 0,
    summaryLines: [],
    collectForceIndividual: false,
    send,
    lastSummaryTarget: undefined,
    summaryOverflowTarget: undefined,
    summaryOverflowOriginKey: undefined,
    consecutiveFailures: 0,
  };
  applyQueueRuntimeSettings({
    target: created,
    settings,
  });
  ANNOUNCE_QUEUES.set(key, created);
  return created;
}

function hasAnnounceCrossChannelItems(items: AnnounceQueueItem[]): boolean {
  return hasCrossChannelItems(items, (item) => {
    if (!item.origin) {
      return {};
    }
    if (!item.originKey) {
      return { cross: true };
    }
    return { key: item.originKey };
  });
}

export function resolveAnnounceCollectEmptySummaryTarget(params: {
  items: AnnounceQueueItem[];
  lastSummaryTarget?: AnnounceQueueItem;
  summaryOverflowTarget?: AnnounceQueueItem;
  summaryOverflowOriginKey?: string | null;
}): AnnounceQueueItem | undefined {
  if (params.items[0]) {
    return params.items[0];
  }
  if (params.summaryOverflowOriginKey === null) {
    return undefined;
  }
  return params.summaryOverflowTarget ?? params.lastSummaryTarget;
}

function clearAnnounceSummaryState(
  queue: Pick<
    AnnounceQueueState,
    | "dropPolicy"
    | "droppedCount"
    | "summaryLines"
    | "summaryOverflowTarget"
    | "summaryOverflowOriginKey"
  >,
): void {
  clearQueueSummaryState(queue);
  queue.summaryOverflowTarget = undefined;
  queue.summaryOverflowOriginKey = undefined;
}

export async function maybeSendAnnounceCollectEmptySummary(params: {
  queue: Pick<
    AnnounceQueueState,
    | "items"
    | "dropPolicy"
    | "droppedCount"
    | "summaryLines"
    | "lastSummaryTarget"
    | "summaryOverflowTarget"
    | "summaryOverflowOriginKey"
  >;
  send: (item: AnnounceQueueItem) => Promise<void>;
}): Promise<boolean> {
  const summaryPrompt = previewQueueSummaryPrompt({ state: params.queue, noun: "announce" });
  const summaryTarget = resolveAnnounceCollectEmptySummaryTarget({
    items: params.queue.items,
    lastSummaryTarget: params.queue.lastSummaryTarget,
    summaryOverflowTarget: params.queue.summaryOverflowTarget,
    summaryOverflowOriginKey: params.queue.summaryOverflowOriginKey,
  });
  if (!summaryPrompt) {
    return false;
  }
  if (!summaryTarget) {
    if (params.queue.summaryOverflowOriginKey === null) {
      clearAnnounceSummaryState(params.queue);
    }
    return false;
  }
  params.queue.lastSummaryTarget = summaryTarget;
  await params.send({
    ...summaryTarget,
    execution: { visibility: "internal", agentPrompt: summaryPrompt },
    display: { visibility: "user-visible", text: summaryPrompt },
  });
  clearAnnounceSummaryState(params.queue);
  return true;
}

function scheduleAnnounceDrain(key: string) {
  const queue = beginQueueDrain(ANNOUNCE_QUEUES, key);
  if (!queue) {
    return;
  }
  void (async () => {
    try {
      const collectState = { forceIndividualCollect: queue.collectForceIndividual };
      for (;;) {
        if (queue.items.length === 0 && queue.droppedCount === 0) {
          break;
        }
        await waitForQueueDebounce(queue);
        if (queue.mode === "collect") {
          const collectDrainResult = await drainCollectQueueStep({
            collectState,
            isCrossChannel: hasAnnounceCrossChannelItems(queue.items),
            items: queue.items,
            run: async (item) => {
              queue.lastSummaryTarget = item;
              await queue.send(item);
            },
          });
          if (collectState.forceIndividualCollect) {
            queue.collectForceIndividual = true;
          }
          if (collectDrainResult === "empty") {
            if (await maybeSendAnnounceCollectEmptySummary({ queue, send: queue.send })) {
              continue;
            }
            break;
          }
          if (collectDrainResult === "drained") {
            continue;
          }
          const items = queue.items.slice();
          const summary = previewQueueSummaryPrompt({ state: queue, noun: "announce" });
          let prompt: string;
          try {
            prompt = renderDeferredBatch({
              title: "[Queued announce messages while agent was busy]",
              items: items.map((item) => item.display),
              summary,
            });
          } catch (err) {
            defaultRuntime.error?.(
              `collect-mode announce batch render failed for ${key}; falling back to individual drain: ${String(err)}`,
            );
            if (summary) {
              const summaryTarget = items[0];
              if (!summaryTarget) {
                break;
              }
              queue.lastSummaryTarget = summaryTarget;
              await queue.send({
                ...summaryTarget,
                execution: { visibility: "internal", agentPrompt: summary },
                display: { visibility: "user-visible", text: summary },
                internalEvents: summaryTarget.internalEvents,
              });
              clearAnnounceSummaryState(queue);
            }
            collectState.forceIndividualCollect = true;
            queue.collectForceIndividual = true;
            continue;
          }
          const internalEvents = items.flatMap((item) => item.internalEvents ?? []);
          const last = items.at(-1);
          if (!last) {
            break;
          }
          queue.lastSummaryTarget = last;
          await queue.send({
            ...last,
            execution: { visibility: "internal", agentPrompt: prompt },
            display: { visibility: "user-visible", text: prompt },
            internalEvents: internalEvents.length > 0 ? internalEvents : last.internalEvents,
          });
          queue.items.splice(0, items.length);
          if (summary) {
            clearAnnounceSummaryState(queue);
          }
          continue;
        }

        const summaryPrompt = previewQueueSummaryPrompt({ state: queue, noun: "announce" });
        if (summaryPrompt) {
          if (
            !(await drainNextQueueItem(queue.items, async (item) => {
              queue.lastSummaryTarget = item;
              await queue.send({
                ...item,
                execution: { visibility: "internal", agentPrompt: summaryPrompt },
                display: { visibility: "user-visible", text: summaryPrompt },
              });
            }))
          ) {
            break;
          }
          clearAnnounceSummaryState(queue);
          continue;
        }

        if (
          !(await drainNextQueueItem(queue.items, async (item) => {
            queue.lastSummaryTarget = item;
            await queue.send(item);
          }))
        ) {
          break;
        }
      }
      // Drain succeeded — reset failure counter.
      queue.consecutiveFailures = 0;
    } catch (err) {
      queue.consecutiveFailures++;
      // Exponential backoff on consecutive failures: 2s, 4s, 8s, ... capped at 60s.
      const errorBackoffMs = Math.min(1000 * Math.pow(2, queue.consecutiveFailures), 60_000);
      const retryDelayMs = Math.max(errorBackoffMs, queue.debounceMs);
      queue.lastEnqueuedAt = Date.now() + retryDelayMs - queue.debounceMs;
      defaultRuntime.error?.(
        `announce queue drain failed for ${key} (attempt ${queue.consecutiveFailures}, retry in ${Math.round(retryDelayMs / 1000)}s): ${String(err)}`,
      );
    } finally {
      queue.draining = false;
      if (queue.items.length === 0 && queue.droppedCount === 0) {
        ANNOUNCE_QUEUES.delete(key);
      } else {
        scheduleAnnounceDrain(key);
      }
    }
  })();
}

export function enqueueAnnounce(params: {
  key: string;
  item: AnnounceQueueItem;
  settings: AnnounceQueueSettings;
  send: (item: AnnounceQueueItem) => Promise<void>;
}): boolean {
  const queue = getAnnounceQueue(params.key, params.settings, params.send);
  // Preserve any retry backoff marker already encoded in lastEnqueuedAt.
  queue.lastEnqueuedAt = Math.max(queue.lastEnqueuedAt, Date.now());

  const shouldEnqueue = applyQueueDropPolicy({
    queue,
    summarize: (item) => {
      if (queue.summaryOverflowOriginKey !== null) {
        const itemOriginKey = item.originKey;
        if (queue.summaryOverflowOriginKey === undefined) {
          queue.summaryOverflowOriginKey = itemOriginKey;
          queue.summaryOverflowTarget = item;
        } else if (queue.summaryOverflowOriginKey === itemOriginKey) {
          queue.summaryOverflowTarget = item;
        } else {
          queue.summaryOverflowOriginKey = null;
          queue.summaryOverflowTarget = undefined;
        }
      }
      const display = item.display;
      if (display.visibility === "summary-only") {
        return display.summaryLine?.trim() || "[summary unavailable]";
      }
      return display.summaryLine?.trim() || display.text?.trim() || "[summary unavailable]";
    },
  });
  if (!shouldEnqueue) {
    if (queue.dropPolicy === "new") {
      scheduleAnnounceDrain(params.key);
    }
    return false;
  }

  const origin = normalizeDeliveryContext(params.item.origin);
  const originKey = deliveryContextKey(origin);
  queue.items.push({ ...params.item, origin, originKey });
  scheduleAnnounceDrain(params.key);
  return true;
}
