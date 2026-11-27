import { getResourceProfile } from "openclaw/plugin-sdk/resource-profile";
import type { StoreConfig } from "./real-vault.js";
import { KnowledgeRestartError } from "./restart-error.js";
import { StorageClient } from "./storage-client.js";

const retired = () =>
  new KnowledgeRestartError(
    "runtime-retired",
    "Knowledge store runtime was retired; retry the original request.",
  );

/** Everything one physical store owns at runtime: its storage worker, its
 * serialized lane and its live-state watcher. Every agent using the store
 * shares this one runtime, so the store has one writer and one publication
 * coordinator (spec §5.3). */
export class StoreRuntime {
  readonly client: StorageClient;
  private pending: Promise<void> = Promise.resolve();
  private retiredAt?: Promise<void>;
  private idleTimer?: NodeJS.Timeout;
  constructor(
    readonly config: StoreConfig,
    private readonly changed?: () => void,
  ) {
    this.client = new StorageClient(config, changed);
  }
  get vaultId() {
    return this.config.vaultId;
  }
  get retired() {
    return this.retiredAt !== undefined;
  }

  /** Run one operation in this store's lane. RealVault fences each operation's
   * manifest/checkpoint snapshot, and a sibling publication advances it, so
   * reads share the lane with writes. `check` runs when the operation starts,
   * so queued work fails once its authority or assignment is gone. */
  enqueue<T>(check: () => void, operation: () => Promise<T>): Promise<T> {
    if (this.retiredAt) {
      return Promise.reject(retired());
    }
    clearTimeout(this.idleTimer);
    const result = this.pending.then(() => {
      if (this.retiredAt) {
        throw retired();
      }
      check();
      return operation();
    });
    // A rejected operation must not poison subsequent reads, writes or recovery.
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.pending = settled;
    if (getResourceProfile() === "lean" && !this.changed) {
      void settled.then(() => {
        if (this.pending !== settled || this.retiredAt) {
          return;
        }
        this.idleTimer = setTimeout(() => {
          if (this.pending !== settled || this.retiredAt) {
            return;
          }
          // Reopening joins termination in the same lane; a multi-RPC operation
          // owns that lane even while no worker reply is outstanding.
          this.pending = this.client.close();
          // Preserve a failed close for the next operation or lifecycle drain.
          void this.pending.catch(() => {});
        }, 60_000).unref();
      });
    }
    return result;
  }
  /** Settles once every operation queued so far has finished or failed. */
  drain(): Promise<void> {
    return this.pending;
  }

  /** Stop accepting work, let queued work settle, then release the worker.
   * Resolves once the worker has exited. */
  retire(): Promise<void> {
    clearTimeout(this.idleTimer);
    this.retiredAt ??= this.pending.then(() => this.client.close());
    return this.retiredAt;
  }
}
