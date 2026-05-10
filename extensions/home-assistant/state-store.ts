/**
 * Entity-state cache for the Home Assistant kiosk bridge.
 *
 * Pure logic, no transport. The WS client feeds state-changed events in via
 * `applyStateChanged`; the gateway bridge (or any other consumer) reads via
 * `subscribe` / `subscribeAll`.
 *
 * Filters at ingestion: states for entities outside `allowList` never enter
 * the store and never reach a listener. The deny-list lives in the service-
 * call gate (Unit 3), not here -- this module is read-only state ingestion.
 */

export type EntityState = {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed?: string;
  last_updated?: string;
};

export type StateChangedEvent = {
  entity_id: string;
  old_state: EntityState | null;
  new_state: EntityState | null;
};

export type StateDiff = {
  entity_id: string;
  prev: EntityState | null;
  next: EntityState | null;
};

export type StateDiffListener = (diff: StateDiff) => void;
export type ListenerErrorListener = (error: { listenerId: number; cause: unknown }) => void;
export type Unsubscribe = () => void;

export type StateStoreOptions = {
  allowList: ReadonlySet<string> | readonly string[];
};

export class HomeAssistantStateStore {
  private readonly allowList: ReadonlySet<string>;
  private readonly entities = new Map<string, EntityState>();
  private readonly anyListeners = new Map<number, StateDiffListener>();
  private readonly perEntityListeners = new Map<string, Map<number, StateDiffListener>>();
  private listenerErrorListeners = new Set<ListenerErrorListener>();
  private listenerCounter = 0;

  constructor(options: StateStoreOptions) {
    this.allowList =
      options.allowList instanceof Set
        ? (options.allowList as ReadonlySet<string>)
        : new Set(options.allowList);
  }

  applyStateChanged(event: StateChangedEvent): void {
    const { entity_id } = event;
    if (!this.allowList.has(entity_id)) {
      return;
    }

    const prev = this.entities.get(entity_id) ?? null;
    const next = event.new_state ?? null;

    if (next) {
      this.entities.set(entity_id, next);
    } else {
      this.entities.delete(entity_id);
    }

    this.emit({ entity_id, prev, next });
  }

  get(entity_id: string): EntityState | undefined {
    return this.entities.get(entity_id);
  }

  subscribe(entity_id: string, listener: StateDiffListener): Unsubscribe {
    const id = ++this.listenerCounter;
    let bucket = this.perEntityListeners.get(entity_id);
    if (!bucket) {
      bucket = new Map();
      this.perEntityListeners.set(entity_id, bucket);
    }
    bucket.set(id, listener);
    return () => {
      const b = this.perEntityListeners.get(entity_id);
      if (!b) {
        return;
      }
      b.delete(id);
      if (b.size === 0) {
        this.perEntityListeners.delete(entity_id);
      }
    };
  }

  subscribeAll(listener: StateDiffListener): Unsubscribe {
    const id = ++this.listenerCounter;
    this.anyListeners.set(id, listener);
    return () => {
      this.anyListeners.delete(id);
    };
  }

  onListenerError(listener: ListenerErrorListener): Unsubscribe {
    this.listenerErrorListeners.add(listener);
    return () => {
      this.listenerErrorListeners.delete(listener);
    };
  }

  /**
   * Clear all stored state and emit a removal diff for each entity that was
   * present. Used after a WS reconnect when the client resubscribes from a
   * fresh state (per the plan's "do not republish stale state on reconnect"
   * decision); downstream consumers see the world flush and refill.
   */
  reset(): void {
    const previous = Array.from(this.entities.entries());
    this.entities.clear();
    for (const [entity_id, prev] of previous) {
      this.emit({ entity_id, prev, next: null });
    }
  }

  private emit(diff: StateDiff): void {
    const perEntity = this.perEntityListeners.get(diff.entity_id);
    if (perEntity) {
      for (const [id, listener] of perEntity) {
        this.dispatchSafely(id, listener, diff);
      }
    }
    for (const [id, listener] of this.anyListeners) {
      this.dispatchSafely(id, listener, diff);
    }
  }

  private dispatchSafely(listenerId: number, listener: StateDiffListener, diff: StateDiff): void {
    try {
      listener(diff);
    } catch (cause) {
      for (const errorListener of this.listenerErrorListeners) {
        try {
          errorListener({ listenerId, cause });
        } catch {
          // Swallow listener-error-listener failures; otherwise we'd lose
          // the original diff for every other consumer.
        }
      }
    }
  }
}
