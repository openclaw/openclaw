import { type QueueDropPolicy, type QueueMode } from "../auto-reply/reply/queue.js";
import { defaultRuntime } from "../runtime.js";
import {
  type DeliveryContext,
  deliveryContextKey,
  normalizeDeliveryContext,
} from "../utils/delivery-context.js";

export type AnnounceQueueItem = {
  prompt: string;
  summaryLine?: string;
  enqueuedAt: number;
  sessionKey: string;
  origin?: DeliveryContext;
  originKey?: string;
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
};

const ANNOUNCE_QUEUES = new Map<string, AnnounceQueueState>();

function getAnnounceQueue(
  key: string,
  settings: AnnounceQueueSettings,
  send: (item: AnnounceQueueItem) => Promise<void>,
) {
  const existing = ANNOUNCE_QUEUES.get(key);
  if (existing) {
    existing.mode = settings.mode;
    existing.debounceMs =
      typeof settings.debounceMs === "number"
        ? Math.max(0, settings.debounceMs)
        : existing.debounceMs;
    existing.cap =
      typeof settings.cap === "number" && settings.cap > 0
        ? Math.floor(settings.cap)
        : existing.cap;
    existing.dropPolicy = settings.dropPolicy ?? existing.dropPolicy;
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
  };
  ANNOUNCE_QUEUES.set(key, created);
  return created;
}

function elideText(text: string, limit = 140): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function buildQueueSummaryLine(item: AnnounceQueueItem): string {
  const base = item.summaryLine?.trim() || item.prompt.trim();
  const cleaned = base.replace(/\s+/g, " ").trim();
  return elideText(cleaned, 160);
}

function waitForQueueDebounce(queue: { debounceMs: number; lastEnqueuedAt: number }) {
  const debounceMs = Math.max(0, queue.debounceMs);
  if (debounceMs <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const check = () => {
      const since = Date.now() - queue.lastEnqueuedAt;
      if (since >= debounceMs) {
        resolve();
        return;
      }
      setTimeout(check, debounceMs - since);
    };
    check();
  });
}

function buildSummaryPrompt(queue: {
  dropPolicy: QueueDropPolicy;
  droppedCount: number;
  summaryLines: string[];
}): string | undefined {
  if (queue.dropPolicy !== "summarize" || queue.droppedCount <= 0) {
    return undefined;
  }
  const lines = [
    `[Queue overflow] Dropped ${queue.droppedCount} announce${queue.droppedCount === 1 ? "" : "s"} due to cap.`,
  ];
  if (queue.summaryLines.length > 0) {
    lines.push("Summary:");
    for (const line of queue.summaryLines) {
      lines.push(`- ${line}`);
    }
  }
  queue.droppedCount = 0;
  queue.summaryLines = [];
  return lines.join("\n");
}

function buildCollectPrompt(items: AnnounceQueueItem[], summary?: string): string {
  const blocks: string[] = ["[Queued announce messages while agent was busy]"];
  if (summary) blocks.push(summary);
  items.forEach((item, idx) => {
    blocks.push(`---\nQueued #${idx + 1}\n${item.prompt}`.trim());
  });
  return blocks.join("\n\n");
}

function hasCrossChannelItems(items: AnnounceQueueItem[]): boolean {
  const keys = new Set<string>();
  let hasUnkeyed = false;
  for (const item of items) {
    if (!item.origin) {
      hasUnkeyed = true;
      continue;
    }
    if (!item.originKey) {
      return true;
    }
    keys.add(item.originKey);
  }
  if (keys.size === 0) return false;
  if (hasUnkeyed) return true;
  return keys.size > 1;
}

function scheduleAnnounceDrain(key: string) {
  const queue = ANNOUNCE_QUEUES.get(key);
  if (!queue || queue.draining) return;
  queue.draining = true;
  void (async () => {
    try {
      let forceIndividualCollect = false;
      while (queue.items.length > 0 || queue.droppedCount > 0) {
        await waitForQueueDebounce(queue);
        if (queue.mode === "collect") {
          if (forceIndividualCollect) {
            const next = queue.items.shift();
            if (!next) break;
            await queue.send(next);
            continue;
          }
          const isCrossChannel = hasCrossChannelItems(queue.items);
          if (isCrossChannel) {
            forceIndividualCollect = true;
            const next = queue.items.shift();
            if (!next) break;
            await queue.send(next);
            continue;
          }
          const items = queue.items.splice(0, queue.items.length);
          const summary = buildSummaryPrompt(queue);
          const prompt = buildCollectPrompt(items, summary);
          const last = items.at(-1);
          if (!last) break;
          await queue.send({ ...last, prompt });
          continue;
        }

        const summaryPrompt = buildSummaryPrompt(queue);
        if (summaryPrompt) {
          const next = queue.items.shift();
          if (!next) break;
          await queue.send({ ...next, prompt: summaryPrompt });
          continue;
        }

        const next = queue.items.shift();
        if (!next) break;
        await queue.send(next);
      }
    } catch (err) {
      defaultRuntime.error?.(`announce queue drain failed for ${key}: ${String(err)}`);
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
  queue.lastEnqueuedAt = Date.now();

  const cap = queue.cap;
  if (cap > 0 && queue.items.length >= cap) {
    if (queue.dropPolicy === "new") {
      scheduleAnnounceDrain(params.key);
      return false;
    }
    const dropCount = queue.items.length - cap + 1;
    const dropped = queue.items.splice(0, dropCount);
    if (queue.dropPolicy === "summarize") {
      for (const droppedItem of dropped) {
        queue.droppedCount += 1;
        queue.summaryLines.push(buildQueueSummaryLine(droppedItem));
      }
      while (queue.summaryLines.length > cap) queue.summaryLines.shift();
    }
  }

  const origin = normalizeDeliveryContext(params.item.origin);
  const originKey = deliveryContextKey(origin);
  queue.items.push({ ...params.item, origin, originKey });
  scheduleAnnounceDrain(params.key);
  return true;
}
