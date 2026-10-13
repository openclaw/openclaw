import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type {
  WorkboardBoardSummary,
  WorkboardChange,
  WorkboardListResult,
} from "@openclaw/workboard-contract";
import type {
  WorkboardCardStore,
  WorkboardKeyedStore,
  WorkboardWriteAuthority,
} from "./persistence-types.js";

export class WorkboardStoreRuntime {
  protected readonly cardLists = new Map<
    string | undefined,
    Promise<
      WorkboardListResult & {
        boards: WorkboardBoardSummary[];
        revision: WorkboardChange & { boardId?: string };
      }
    >
  >();
  private readonly operationScope = new AsyncLocalStorage<{ active: boolean }>();
  private readonly operations = new Set<Promise<unknown>>();
  private mutationQueue: Promise<unknown> = Promise.resolve();
  private closePromise: Promise<void> | undefined;
  private sealed = false;
  protected cardsRevision: WorkboardChange = { epoch: randomUUID(), revision: 1 };
  private sessionBoardRevision: WorkboardChange = { epoch: this.cardsRevision.epoch, revision: 1 };
  private writeToken: string | undefined;
  private revision = 0;
  private readonly listeners = new Set<(change: WorkboardChange) => void>();
  private readonly initialization: Promise<void>;

  constructor(
    private readonly closePersistence?: () => void | Promise<void>,
    ready?: Promise<void>,
    private readonly runWithWriteAuthority?: WorkboardWriteAuthority,
    private readonly readWriteToken?: () => string | undefined,
  ) {
    this.initialization = ready ?? Promise.resolve();
    void this.initialization.catch(() => {});
  }

  ready(): Promise<void> {
    return this.runOperation(() => undefined);
  }

  get sessionsRevision(): WorkboardChange {
    this.refreshWriteReceipt();
    return this.sessionBoardRevision;
  }

  protected refreshWriteReceipt(): string | undefined {
    if (!this.readWriteToken) {
      return "local";
    }
    const current = this.readWriteToken();
    if (current === undefined || current !== this.writeToken) {
      this.writeToken = current;
      this.invalidateCards();
      this.invalidateSessionBoards();
    }
    return current;
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
        this.cardLists.clear();
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
    {
      notifyChanges = true,
      sessions = false,
    }: { notifyChanges?: boolean; sessions?: boolean } = {},
  ): WorkboardKeyedStore<T> {
    return {
      register: (key, value) =>
        this.trackMutation(
          () => store.register(key, value),
          () => notifyChanges,
          sessions,
        ),
      lookup: (key) => this.runOperation(() => store.lookup(key)),
      delete: (key) =>
        this.trackMutation(
          () => store.delete(key),
          (deleted) => deleted && notifyChanges,
          sessions,
        ),
      entries: () => this.runOperation(() => store.entries()),
    };
  }

  protected trackCardStore(store: WorkboardCardStore): WorkboardCardStore {
    return {
      ...this.track(store),
      entries: (scope) => this.runOperation(() => store.entries(scope)),
      registerIfAbsent: (key, value) =>
        this.trackMutation(() => store.registerIfAbsent(key, value)),
      registerIfUpdatedAt: (key, value, expectedUpdatedAt) =>
        this.trackMutation(() => store.registerIfUpdatedAt(key, value, expectedUpdatedAt)),
      deleteIfUpdatedAt: (key, expectedUpdatedAt) =>
        this.trackMutation(() => store.deleteIfUpdatedAt(key, expectedUpdatedAt)),
      claimIfOwnerAvailable: (key, value, expectedUpdatedAt, ownerId, now) =>
        this.trackMutation(
          () => store.claimIfOwnerAvailable(key, value, expectedUpdatedAt, ownerId, now),
          (result) => result === "updated",
        ),
      listCardStatuses: (ids) => this.runOperation(() => store.listCardStatuses(ids)),
      listBoardAggregates: () => this.runOperation(() => store.listBoardAggregates()),
      listStatsAggregates: (boardId) => this.runOperation(() => store.listStatsAggregates(boardId)),
      hasCards: (boardId) => this.runOperation(() => store.hasCards(boardId)),
    };
  }

  protected trackMutation<T>(
    run: () => Promise<T>,
    changed: (result: T) => boolean = Boolean,
    sessions = false,
  ): Promise<T> {
    return this.runOperation(async () => {
      try {
        const result = await run();
        if (changed(result)) {
          this.invalidateCards();
          if (sessions) {
            this.invalidateSessionBoards();
          }
        }
        return result;
      } catch (error) {
        // A rejected reply may follow a commit. Retire cached facts without replaying the write.
        this.invalidateCards();
        if (sessions) {
          this.invalidateSessionBoards();
        }
        throw error;
      }
    });
  }

  subscribeChanges(listener: (change: WorkboardChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  invalidateSessionBoards(): void {
    this.sessionBoardRevision = {
      ...this.sessionBoardRevision,
      revision: this.sessionBoardRevision.revision + 1,
    };
  }

  announceChangeEpoch(): void {
    this.emit();
  }

  protected async enqueueMutation<T>(
    run: () => Promise<T>,
    assertCurrent?: () => void,
  ): Promise<T> {
    return await this.runOperation(async () => {
      const runAndNotify = () =>
        this.withMutationAuthority(() => this.runMutation(run), assertCurrent);
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
    const initialRevision = this.cardsRevision.revision;
    try {
      return await run();
    } finally {
      if (this.cardsRevision.revision !== initialRevision) {
        this.emit();
      }
    }
  }

  private invalidateCards(): void {
    // Every list includes all board summaries, so even a board-scoped payload
    // depends on the whole store revision published by the owning writer.
    this.cardLists.clear();
    this.cardsRevision = { ...this.cardsRevision, revision: this.cardsRevision.revision + 1 };
  }

  private emit(): void {
    this.refreshWriteReceipt();
    const change = {
      epoch: this.cardsRevision.epoch,
      revision: ++this.revision,
      cardsRevision: this.cardsRevision.revision,
      sessionsRevision: this.sessionBoardRevision.revision,
    };
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch {
        // Persistence already succeeded. Observers cannot turn it into a reported failure.
      }
    }
  }
}
