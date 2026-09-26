import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { WorkboardChange } from "@openclaw/workboard-contract";
import type {
  WorkboardCardStore,
  WorkboardKeyedStore,
  WorkboardWriteAuthority,
} from "./persistence-types.js";

export class WorkboardStoreRuntime {
  private readonly operationScope = new AsyncLocalStorage<{ active: boolean }>();
  private readonly operations = new Set<Promise<unknown>>();
  private mutationQueue: Promise<unknown> = Promise.resolve();
  private closePromise: Promise<void> | undefined;
  private sealed = false;
  private readonly epoch = randomUUID();
  private revision = 0;
  private mutationRevision = 0;
  private externalDataVersion: number | undefined;
  private readonly listeners = new Set<(change: WorkboardChange) => void>();
  private readonly initialization: Promise<void>;

  constructor(
    private readonly readDataVersion?: () => number | Promise<number>,
    private readonly closePersistence?: () => void | Promise<void>,
    ready?: Promise<number>,
    private readonly runWithWriteAuthority?: WorkboardWriteAuthority,
  ) {
    this.initialization = Promise.resolve(ready ?? readDataVersion?.()).then((version) => {
      this.externalDataVersion = version;
    });
    void this.initialization.catch(() => {});
  }

  ready(): Promise<void> {
    return this.runOperation(() => undefined);
  }

  async runOperation<T>(run: () => T | Promise<T>): Promise<T> {
    if (this.sealed && !this.operationScope.getStore()?.active) {
      throw new Error("workboard store is closed.");
    }
    const context = { active: true };
    const operation = this.operationScope.run(context, async () => {
      await this.initialization;
      return await run();
    });
    this.operations.add(operation);
    try {
      return await operation;
    } finally {
      // Detached callbacks must not reuse admission after this operation settles.
      context.active = false;
      this.operations.delete(operation);
    }
  }

  close(): Promise<void> {
    this.sealed = true;
    this.closePromise ??= Promise.resolve()
      .then(async () => {
        // Admitted operations can still add nested work. Callers own failures;
        // join the entire set before closing this generation's connection.
        while (this.operations.size > 0) {
          await Promise.allSettled(this.operations);
        }
        this.operationScope.disable();
        await this.closePersistence?.();
      })
      .catch((error: unknown) => {
        this.closePromise = undefined;
        throw error;
      });
    return this.closePromise;
  }

  protected track<T>(
    store: WorkboardKeyedStore<T>,
    { notifyChanges = true }: { notifyChanges?: boolean } = {},
  ): WorkboardKeyedStore<T> {
    return {
      register: (key, value) =>
        this.runOperation(async () => {
          await store.register(key, value);
          if (notifyChanges) {
            this.mutationRevision += 1;
          }
        }),
      lookup: (key) => this.runOperation(() => store.lookup(key)),
      delete: (key) =>
        this.runOperation(async () => {
          const deleted = await store.delete(key);
          if (deleted && notifyChanges) {
            this.mutationRevision += 1;
          }
          return deleted;
        }),
      entries: () => this.runOperation(() => store.entries()),
    };
  }

  protected trackCardStore(store: WorkboardCardStore): WorkboardCardStore {
    const trackConditionalMutation = (run: () => Promise<boolean>) =>
      this.runOperation(async () => {
        const changed = await run();
        if (changed) {
          this.mutationRevision += 1;
        }
        return changed;
      });
    return {
      ...this.track(store),
      entries: (scope) => this.runOperation(() => store.entries(scope)),
      registerIfAbsent: (key, value) =>
        trackConditionalMutation(() => store.registerIfAbsent(key, value)),
      registerIfUpdatedAt: (key, value, expectedUpdatedAt) =>
        trackConditionalMutation(() => store.registerIfUpdatedAt(key, value, expectedUpdatedAt)),
      deleteIfUpdatedAt: (key, expectedUpdatedAt) =>
        trackConditionalMutation(() => store.deleteIfUpdatedAt(key, expectedUpdatedAt)),
      claimIfOwnerAvailable: (key, value, expectedUpdatedAt, ownerId, now) =>
        this.runOperation(async () => {
          const result = await store.claimIfOwnerAvailable(
            key,
            value,
            expectedUpdatedAt,
            ownerId,
            now,
          );
          if (result === "updated") {
            this.mutationRevision += 1;
          }
          return result;
        }),
      listCardStatuses: (ids) => this.runOperation(() => store.listCardStatuses(ids)),
      listBoardAggregates: () => this.runOperation(() => store.listBoardAggregates()),
      listStatsAggregates: (boardId) => this.runOperation(() => store.listStatsAggregates(boardId)),
      hasCards: (boardId) => this.runOperation(() => store.hasCards(boardId)),
    };
  }

  subscribeChanges(listener: (change: WorkboardChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  announceChangeEpoch(): void {
    this.emit();
  }

  reconcileExternalChanges(): Promise<boolean> {
    return this.runOperation(async () => {
      if (!this.readDataVersion) {
        return false;
      }
      const current = await this.readDataVersion();
      if (current === this.externalDataVersion) {
        return false;
      }
      this.externalDataVersion = current;
      this.emit();
      return true;
    });
  }

  protected async enqueueMutation<T>(
    run: () => Promise<T>,
    assertCurrent?: () => void,
  ): Promise<T> {
    return await this.runOperation(async () => {
      const runAndNotify = async () =>
        await this.withMutationAuthority(async () => await this.runMutation(run), assertCurrent);
      const result = this.mutationQueue.then(runAndNotify, runAndNotify);
      this.mutationQueue = result.then(
        () => undefined,
        () => undefined,
      );
      return await result;
    });
  }

  protected async withMutationAuthority<T>(
    run: () => Promise<T>,
    assertCurrent?: () => void,
  ): Promise<T> {
    if (!assertCurrent) {
      return await run();
    }
    if (!this.runWithWriteAuthority) {
      throw new Error("Workboard persistence does not support current-owner admission.");
    }
    return await this.runWithWriteAuthority(assertCurrent, run);
  }

  private async runMutation<T>(run: () => Promise<T>): Promise<T> {
    const initialRevision = this.mutationRevision;
    try {
      return await run();
    } finally {
      if (this.mutationRevision !== initialRevision) {
        this.emit();
      }
    }
  }

  private emit(): void {
    const change = { epoch: this.epoch, revision: ++this.revision };
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch {
        // Persistence already succeeded. Observers cannot turn it into a reported failure.
      }
    }
  }
}
