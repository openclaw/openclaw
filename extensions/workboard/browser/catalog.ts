import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { GatewayBrowserClient } from "./api/gateway.ts";
import type { WorkboardCapability } from "./lib/workboard/capability.ts";
import { normalizeWorkboardChange } from "./lib/workboard/change-payload.ts";
import { normalizeCardsPayload } from "./lib/workboard/normalization.ts";
import { getWorkboardState, invalidateWorkboardLoads } from "./lib/workboard/runtime.ts";
import { WORKBOARD_CHANGED_EVENT, type WorkboardBoardSummary } from "./lib/workboard/types.ts";

type WorkboardCatalogSnapshot = {
  boards: readonly Pick<WorkboardBoardSummary, "id" | "name" | "kind" | "icon" | "color">[];
  ready: boolean;
};

const RETRY_MS = 2_000;

export class WorkboardCatalog {
  private client: GatewayBrowserClient | null = null;
  private connected = false;
  private disposed = false;
  private retryTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private load: Promise<boolean> | null = null;
  private pending = false;
  private generation = 0;
  private lastChange: ReturnType<typeof normalizeWorkboardChange> = null;
  private snapshot: WorkboardCatalogSnapshot = { boards: [], ready: false };

  constructor(
    private readonly onSnapshot: (snapshot: WorkboardCatalogSnapshot) => void,
    private readonly host: WorkboardCapability,
  ) {}

  sync(client: GatewayBrowserClient | null, connected: boolean): void {
    if (this.disposed) {
      return;
    }
    const reconnecting = connected && !this.connected && this.snapshot.ready;
    if (this.connected !== connected || this.client !== client) {
      this.invalidate();
    }
    this.connected = connected;
    if (!connected || !client) {
      this.clearRetry();
      return;
    }
    if (this.client !== client) {
      this.client = client;
      this.host.clearCatalog();
      this.publishCatalog([], false);
    }
    this.ensureAndRecover(reconnecting);
  }

  handleGatewayEvent(event: string, payload?: unknown): void {
    if (event !== WORKBOARD_CHANGED_EVENT || !this.connected || !this.client) {
      return;
    }
    const change = normalizeWorkboardChange(payload);
    if (
      change &&
      this.lastChange?.epoch === change.epoch &&
      (change.revision <= this.lastChange.revision ||
        (change.cardsRevision !== undefined &&
          change.cardsRevision === this.lastChange.cardsRevision))
    ) {
      return;
    }
    this.lastChange = change;
    this.ensureAndRecover(true);
  }

  refresh(): void {
    this.invalidate();
    this.ensureAndRecover(true);
  }

  removeBoard(id: string): void {
    this.invalidate();
    const state = getWorkboardState(this.host);
    state.boards = state.boards.filter((board) => board.id !== id);
    this.publishCatalog(state.boards, this.snapshot.ready);
    this.ensureAndRecover(true);
  }

  dispose(): void {
    this.disposed = true;
    this.clearRetry();
    this.invalidate();
    this.host.clearCatalog();
  }

  private ensureAndRecover(force: boolean): void {
    const client = this.client;
    if (this.disposed || !client || !this.connected) {
      return;
    }
    const generation = this.generation;
    void this.ensure(client, force).then((loaded) => {
      if (this.disposed || generation !== this.generation) {
        return;
      }
      if (loaded) {
        this.clearRetry();
        return;
      }
      if (!force && this.snapshot.ready) {
        return;
      }
      if (this.retryTimer === null) {
        this.retryTimer = globalThis.setTimeout(() => {
          this.retryTimer = null;
          this.ensureAndRecover(true);
        }, RETRY_MS);
      }
    });
  }

  private async ensure(client: GatewayBrowserClient, force: boolean): Promise<boolean> {
    if (this.load) {
      this.pending ||= force;
      return this.load;
    }
    if (!force && this.snapshot.ready) {
      return false;
    }
    const generation = this.generation;
    const load = Promise.resolve().then(async () => {
      try {
        do {
          this.pending = false;
          const payload = await client.request("workboard.boards.list", {});
          if (
            generation !== this.generation ||
            !isRecord(payload) ||
            !Array.isArray(payload.boards)
          ) {
            return false;
          }
          const { boards } = normalizeCardsPayload({ boards: payload.boards });
          getWorkboardState(this.host).boards = boards;
          this.publishCatalog(boards, true);
        } while (this.pending);
        return true;
      } catch {
        return false;
      } finally {
        if (this.load === load) {
          this.load = null;
        }
      }
    });
    this.load = load;
    return load;
  }

  private invalidate(): void {
    this.generation += 1;
    this.load = null;
    this.pending = false;
    this.lastChange = null;
    invalidateWorkboardLoads(this.host);
  }

  private publishCatalog(boards: WorkboardBoardSummary[], ready: boolean): void {
    this.host.setBoardsReady(ready);
    this.host.notify();
    const snapshot: WorkboardCatalogSnapshot = {
      boards: boards.map(({ id, name, kind, icon, color }) => ({
        id,
        ...(name ? { name } : {}),
        ...(kind ? { kind } : {}),
        ...(icon ? { icon } : {}),
        ...(color ? { color } : {}),
      })),
      ready,
    };
    this.snapshot = snapshot;
    this.onSnapshot(snapshot);
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) {
      globalThis.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }
}
