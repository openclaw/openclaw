import type { GatewayBrowserClient } from "./api/gateway.ts";
import type { WorkboardCapability } from "./lib/workboard/capability.ts";
import { loadWorkboardCatalog } from "./lib/workboard/loading.ts";
import {
  getWorkboardRuntime,
  getWorkboardState,
  hasCurrentWorkboardCards,
  invalidateWorkboardLoads,
} from "./lib/workboard/runtime.ts";
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
  private generation = 0;
  private connectionGeneration = 0;
  private retryTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
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
      this.connectionGeneration += 1;
      this.generation += 1;
      invalidateWorkboardLoads(this.host);
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
    if (
      event === WORKBOARD_CHANGED_EVENT &&
      this.connected &&
      this.client &&
      !hasCurrentWorkboardCards(this.host, payload)
    ) {
      this.ensureAndRecover(true);
    }
  }

  removeBoard(id: string): void {
    this.generation += 1;
    invalidateWorkboardLoads(this.host);
    const state = getWorkboardState(this.host);
    state.boards = state.boards.filter((board) => board.id !== id);
    this.publishCatalog(state.boards, this.snapshot.ready);
    this.ensureAndRecover(true);
  }

  dispose(): void {
    this.disposed = true;
    this.connectionGeneration += 1;
    this.generation += 1;
    this.clearRetry();
    invalidateWorkboardLoads(this.host);
    this.host.clearCatalog();
  }

  private ensureAndRecover(force: boolean): void {
    const client = this.client;
    if (this.disposed || !client || !this.connected) {
      return;
    }
    const connectionGeneration = this.connectionGeneration;
    void this.ensure(client, force).then((loaded) => {
      if (
        this.disposed ||
        !this.connected ||
        this.client !== client ||
        connectionGeneration !== this.connectionGeneration
      ) {
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
    if (!force && (this.snapshot.ready || getWorkboardRuntime(this.host).loadPromise)) {
      return false;
    }
    const generation = ++this.generation;
    const loaded = await loadWorkboardCatalog({
      host: this.host,
      client,
      requestUpdate: this.host.notify,
    });
    if (
      !loaded ||
      this.disposed ||
      !this.connected ||
      this.client !== client ||
      generation !== this.generation
    ) {
      return false;
    }
    this.publishCatalog(getWorkboardState(this.host).boards, true);
    return true;
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
