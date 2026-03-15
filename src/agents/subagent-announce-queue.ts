import { type QueueDropPolicy, type QueueMode } from "../auto-reply/reply/queue.js";
import { loadConfig } from "../config/config.js";
import { defaultRuntime } from "../runtime.js";
import {
  type DeliveryContext,
  deliveryContextKey,
  normalizeDeliveryContext,
} from "../utils/delivery-context.js";
import {
  applyQueueRuntimeSettings,
  applyQueueDropPolicy,
  beginQueueDrain,
  buildCollectPrompt,
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
  prompt: string;
  summaryLine?: string;
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
  send: (item: AnnounceQueueItem) => Promise<void>;
  /** Consecutive drain failures — drives exponential backoff on errors. */
  consecutiveFailures: number;
};

/** Default max consecutive drain failures before the failing item is dropped. */
const DEFAULT_ANNOUNCE_MAX_DRAIN_FAILURES = 5;

function resolveAnnounceMaxDrainFailures(): number {
  const configured = loadConfig().agents?.defaults?.subagents?.announceMaxDrainFailures;
  if (typeof configured !== "number" || !Number.isFinite(configured)) {
    return DEFAULT_ANNOUNCE_MAX_DRAIN_FAILURES;
  }
  return Math.max(1, Math.floor(configured));
}

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
    send,
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

function scheduleAnnounceDrain(key: string) {
  const queue = beginQueueDrain(ANNOUNCE_QUEUES, key);
  if (!queue) {
    return;
  }
  void (async () => {
    try {
      const collectState = { forceIndividualCollect: false };
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
            run: async (item) => await queue.send(item),
          });
          if (collectDrainResult === "empty") {
            break;
          }
          if (collectDrainResult === "drained") {
            continue;
          }
          const items = queue.items.slice();
          const summary = previewQueueSummaryPrompt({ state: queue, noun: "announce" });
          const prompt = buildCollectPrompt({
            title: "[Queued announce messages while agent was busy]",
            items,
            summary,
            renderItem: (item, idx) => `---\nQueued #${idx + 1}\n${item.prompt}`.trim(),
          });
          const internalEvents = items.flatMap((item) => item.internalEvents ?? []);
          const last = items.at(-1);
          if (!last) {
            break;
          }
          await queue.send({
            ...last,
            prompt,
            internalEvents: internalEvents.length > 0 ? internalEvents : last.internalEvents,
          });
          queue.items.splice(0, items.length);
          if (summary) {
            clearQueueSummaryState(queue);
          }
          continue;
        }

        const summaryPrompt = previewQueueSummaryPrompt({ state: queue, noun: "announce" });
        if (summaryPrompt) {
          if (
            !(await drainNextQueueItem(
              queue.items,
              async (item) => await queue.send({ ...item, prompt: summaryPrompt }),
            ))
          ) {
            break;
          }
          clearQueueSummaryState(queue);
          continue;
        }

        if (!(await drainNextQueueItem(queue.items, async (item) => await queue.send(item)))) {
          break;
        }
      }
      // Drain succeeded — reset failure counter.
      queue.consecutiveFailures = 0;
    } catch (err) {
      queue.consecutiveFailures++;
      const maxFailures = resolveAnnounceMaxDrainFailures();
      if (queue.consecutiveFailures >= maxFailures) {
        queue.items.shift();
        defaultRuntime.error?.(
          `announce queue for ${key} exceeded ${maxFailures} consecutive failures, dropping failing item and continuing (${queue.items.length} remaining): ${String(err)}`,
        );
        // Reset failure counter so the next item gets a fair chance.
        queue.consecutiveFailures = 0;
        // Clear stale summary state only when the queue is now empty,
        // so it does not keep the queue alive forever (droppedCount > 0
        // with no items to carry the summary). When items remain,
        // preserve the overflow notice for the next successful delivery.
        if (queue.items.length === 0) {
          queue.droppedCount = 0;
          queue.summaryLines.length = 0;
        }
        return;
      }
      // Exponential backoff on consecutive failures: 2s, 4s, 8s, ... capped at 60s.
      const errorBackoffMs = Math.min(1000 * Math.pow(2, queue.consecutiveFailures), 60_000);
      const retryDelayMs = Math.max(errorBackoffMs, queue.debounceMs);
      queue.lastEnqueuedAt = Date.now() + retryDelayMs - queue.debounceMs;
      defaultRuntime.error?.(
        `announce queue drain failed for ${key} (attempt ${queue.consecutiveFailures}/${maxFailures}, retry in ${Math.round(retryDelayMs / 1000)}s): ${String(err)}`,
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
    summarize: (item) => item.summaryLine?.trim() || item.prompt.trim(),
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
