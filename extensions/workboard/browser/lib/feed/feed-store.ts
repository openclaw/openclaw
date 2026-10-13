import type { ControlUiHost } from "openclaw/plugin-sdk/control-ui";
import { formatUiError } from "../format-error.ts";
import type { WorkboardCard } from "../workboard/types.ts";
import { WORKBOARD_CHANGED_EVENT } from "../workboard/types.ts";
import { buildFeedView, type FeedView } from "./feed-view.ts";

type FeedListResult = { cards?: WorkboardCard[]; ownerName?: string };
type FeedCardResult = { card?: WorkboardCard };

const FEED_REFRESH_DEBOUNCE_MS = 250;

export type FeedStore = {
  readonly cards: readonly WorkboardCard[];
  readonly ownerName: string | undefined;
  readonly loaded: boolean;
  readonly error: string | null;
  view: (now?: number) => FeedView;
  openCount: () => number;
  subscribe: (listener: () => void) => () => void;
  refresh: () => Promise<void>;
  act: (id: string, actionId: string, draft?: string) => Promise<void>;
  ack: (id: string, acked: boolean) => Promise<void>;
  comment: (id: string, body: string, draft?: string) => Promise<void>;
  saveDraft: (id: string, draft: string) => Promise<void>;
  dispose: () => void;
};

/** One Feed data source per plugin activation: the page and the nav badge read the same cards. */
export function createFeedStore(host: ControlUiHost): FeedStore {
  let cards: WorkboardCard[] = [];
  let ownerName: string | undefined;
  let loaded = false;
  let error: string | null = null;
  let disposed = false;
  let connected = false;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inflight: Promise<void> | null = null;
  let rerun = false;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  const load = async (): Promise<void> => {
    if (disposed || !host.connection.connected) {
      return;
    }
    if (inflight) {
      rerun = true;
      return await inflight;
    }
    const current = generation;
    inflight = (async () => {
      try {
        const result = await host.request<FeedListResult>("workboard.feed.list", {});
        if (disposed || current !== generation) {
          return;
        }
        cards = result.cards ?? [];
        ownerName = result.ownerName;
        loaded = true;
        error = null;
      } catch (err) {
        if (!disposed && current === generation) {
          error = formatUiError(err);
        }
      } finally {
        inflight = null;
        notify();
      }
    })();
    await inflight;
    if (rerun && !disposed) {
      rerun = false;
      await load();
    }
  };

  const scheduleRefresh = () => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = undefined;
      void load();
    }, FEED_REFRESH_DEBOUNCE_MS);
  };

  const replaceCard = (card: WorkboardCard | undefined) => {
    if (!card) {
      return;
    }
    const index = cards.findIndex((entry) => entry.id === card.id);
    cards = index === -1 ? [...cards, card] : cards.with(index, card);
    notify();
  };

  const mutate = async (method: string, params: Record<string, unknown>) => {
    const result = await host.request<FeedCardResult>(method, params);
    replaceCard(result.card);
  };

  const syncConnection = () => {
    if (connected === host.connection.connected) {
      return;
    }
    connected = host.connection.connected;
    generation += 1;
    if (connected) {
      void load();
    }
  };
  const unsubscribeHost = host.subscribe(syncConnection);
  const unsubscribeEvents = host.onEvent(WORKBOARD_CHANGED_EVENT, scheduleRefresh);
  syncConnection();

  return {
    get cards() {
      return cards;
    },
    get ownerName() {
      return ownerName;
    },
    get loaded() {
      return loaded;
    },
    get error() {
      return error;
    },
    view: (now) => buildFeedView(cards, now),
    openCount: () => buildFeedView(cards).open.length,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh: load,
    act: (id, actionId, draft) =>
      mutate("workboard.feed.act", {
        id,
        actionId,
        ...(draft !== undefined ? { draft } : {}),
        idempotencyKey: `workboard-feed:${id}:${actionId}:${Date.now()}`,
      }),
    ack: (id, acked) => mutate("workboard.feed.ack", { id, acked }),
    comment: (id, body, draft) =>
      mutate("workboard.feed.comment", {
        id,
        body,
        ...(draft !== undefined ? { draft } : {}),
        idempotencyKey: `workboard-feed:${id}:comment:${Date.now()}`,
      }),
    saveDraft: (id, draft) => mutate("workboard.feed.update", { id, draft }),
    dispose() {
      disposed = true;
      if (timer) {
        clearTimeout(timer);
      }
      unsubscribeHost();
      unsubscribeEvents();
      listeners.clear();
    },
  };
}
