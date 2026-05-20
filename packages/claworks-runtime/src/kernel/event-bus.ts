import {
  compareEventPriority,
  resolveEventPriority,
  type EventPriority,
} from "./event-priority.js";
import type { PlaybookMatcher } from "./playbook-matcher.js";
import type { CwEvent, CwEventMatch, EventQueryOptions } from "./types.js";

export interface EventBus {
  publish(event: CwEvent): Promise<CwEventMatch[]>;
  subscribe(pattern: string, handler: (event: CwEvent) => Promise<void>): () => void;
  query(opts: EventQueryOptions): Promise<CwEvent[]>;
}

export type EventBusOptions = {
  matcher: PlaybookMatcher;
  maxLogEntries?: number;
  onMatch?: (matches: CwEventMatch[]) => Promise<void>;
};

type QueuedPublish = {
  event: CwEvent;
  priority: EventPriority;
  resolve: (matches: CwEventMatch[]) => void;
};

export function createEventBus(opts: EventBusOptions): EventBus {
  const log: CwEvent[] = [];
  const maxLog = opts.maxLogEntries ?? 10_000;
  const subscribers = new Map<string, Set<(event: CwEvent) => Promise<void>>>();
  const queue: QueuedPublish[] = [];
  let draining = false;

  async function processPublish(event: CwEvent): Promise<CwEventMatch[]> {
    log.push(event);
    if (log.length > maxLog) {
      log.splice(0, log.length - maxLog);
    }

    const subs = subscribers.get(event.type) ?? new Set();
    const wildcardSubs = subscribers.get("*") ?? new Set();
    for (const handler of [...subs, ...wildcardSubs]) {
      void handler(event).catch(() => undefined);
    }

    const matches = opts.matcher.match(event);
    if (matches.length > 0 && opts.onMatch) {
      await opts.onMatch(matches);
    }
    return matches;
  }

  async function drain(): Promise<void> {
    if (draining) {
      return;
    }
    draining = true;
    try {
      while (queue.length > 0) {
        queue.sort((a, b) => compareEventPriority(a.priority, b.priority));
        const next = queue.shift()!;
        const matches = await processPublish(next.event);
        next.resolve(matches);
      }
    } finally {
      draining = false;
    }
  }

  return {
    async publish(event: CwEvent): Promise<CwEventMatch[]> {
      if (draining) {
        return await processPublish(event);
      }
      const priority = resolveEventPriority(event.type, event.payload);
      return await new Promise<CwEventMatch[]>((resolve) => {
        queue.push({ event, priority, resolve });
        void drain();
      });
    },

    subscribe(pattern: string, handler: (event: CwEvent) => Promise<void>): () => void {
      const set = subscribers.get(pattern) ?? new Set();
      set.add(handler);
      subscribers.set(pattern, set);
      return () => {
        set.delete(handler);
      };
    },

    async query(opts: EventQueryOptions): Promise<CwEvent[]> {
      let results = [...log];
      if (opts.type) {
        results = results.filter((e) => e.type === opts.type);
      }
      if (opts.source) {
        results = results.filter((e) => e.source === opts.source);
      }
      if (opts.from) {
        results = results.filter((e) => e.timestamp >= opts.from!);
      }
      if (opts.to) {
        results = results.filter((e) => e.timestamp <= opts.to!);
      }
      const limit = opts.limit ?? 50;
      const offset = opts.cursor ? Number.parseInt(opts.cursor, 10) : 0;
      return results.slice(offset, offset + limit);
    },
  };
}
