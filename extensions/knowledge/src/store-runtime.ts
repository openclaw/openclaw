import { LiveState } from "./live-state.js";
import type { StoreConfig } from "./real-vault.js";
import { StorageClient } from "./storage-client.js";

const retired = () => new Error("Knowledge store runtime was retired; retry the original request.");

/** Everything one physical store owns at runtime: its storage worker, its
 * serialized lane and its live-state watcher. Every agent using the store
 * shares this one runtime, so the store has one writer and one publication
 * coordinator (spec §5.3). */
export class StoreRuntime {
  readonly client: StorageClient;
  readonly live: LiveState;
  private pending: Promise<void> = Promise.resolve();
  private retiredAt?: Promise<void>;
  constructor(
    readonly config: StoreConfig,
    changed: () => void,
  ) {
    this.client = new StorageClient(config);
    this.live = new LiveState(config.root, changed);
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
    const result = this.pending.then(() => {
      if (this.retiredAt) {
        throw retired();
      }
      check();
      return operation();
    });
    // A rejected operation must not poison subsequent reads, writes or recovery.
    this.pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  /** Settles once every operation queued so far has finished or failed. */
  drain(): Promise<void> {
    return this.pending;
  }

  /** Stop accepting work, let queued work settle, then release the worker. */
  retire(): Promise<void> {
    this.retiredAt ??= this.pending.then(() => {
      this.live.stop();
      this.client.close();
    });
    return this.retiredAt;
  }
}
