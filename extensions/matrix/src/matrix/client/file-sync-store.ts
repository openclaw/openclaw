import {
  MemoryStore,
  SyncAccumulator,
  type ISyncData,
  type ISyncResponse,
  type IStoredClientOpts,
} from "matrix-js-sdk/lib/matrix.js";
import { createAsyncLock } from "openclaw/plugin-sdk/async-lock-runtime";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { getMatrixRuntime } from "../../runtime.js";
import { LogService } from "../sdk/logger.js";
import { claimCurrentTokenStorageState } from "./storage.js";
import {
  MATRIX_SYNC_CACHE_VERSION,
  deleteMatrixSyncCacheStateFromStore,
  openMatrixSyncCacheStoreOptions,
  readPersistedStoreFromStore,
  writeMatrixSyncCacheStateToStore,
  type MatrixSyncCacheRecord,
  type PersistedMatrixSyncStore,
} from "./sync-cache-state.js";

const PERSIST_DEBOUNCE_MS = 250;

export type MatrixSyncIngressHandler = (
  sync: ISyncResponse,
  context: { hasSavedSync: boolean },
) => Promise<void>;

function syncDataToSyncResponse(syncData: ISyncData): ISyncResponse {
  return {
    next_batch: syncData.nextBatch,
    rooms: syncData.roomsData,
    account_data: {
      events: syncData.accountData,
    },
  };
}

export class SqliteBackedMatrixSyncStore extends MemoryStore {
  private readonly persistLock = createAsyncLock();
  private readonly accumulator = new SyncAccumulator();
  private savedSync: ISyncData | null = null;
  private savedClientOptions: IStoredClientOpts | undefined;
  private readonly hadSavedSyncOnLoad: boolean;
  private readonly hadCleanShutdownOnLoad: boolean;
  private cleanShutdown = false;
  private dirty = false;
  private frozen = false;
  private persistTimer: NodeJS.Timeout | null = null;
  private persistPromise: Promise<void> | null = null;
  private syncIngressHandler: MatrixSyncIngressHandler | undefined;
  private syncIngressAdmission: Promise<void> | null = null;

  static async create(storageRootDir: string): Promise<SqliteBackedMatrixSyncStore> {
    let store: PluginStateKeyedStore<MatrixSyncCacheRecord, 2> | undefined;
    let persisted: PersistedMatrixSyncStore | null = null;
    let unavailableError: unknown;
    try {
      store = getMatrixRuntime().state.openKeyedStoreV2<MatrixSyncCacheRecord>(
        openMatrixSyncCacheStoreOptions(storageRootDir),
      );
      persisted = await readPersistedStoreFromStore({ storageRootDir, store });
    } catch (error) {
      unavailableError = error;
      LogService.warn("MatrixSyncCacheStore", "Failed to load Matrix sync cache:", error);
    }
    return new SqliteBackedMatrixSyncStore(storageRootDir, store, persisted, unavailableError);
  }

  private constructor(
    private readonly storageRootDir: string,
    private readonly store: PluginStateKeyedStore<MatrixSyncCacheRecord, 2> | undefined,
    persisted: PersistedMatrixSyncStore | null,
    private readonly storeUnavailableError: unknown,
  ) {
    super();
    const restoredSavedSync = persisted?.savedSync ?? null;
    const restoredClientOptions = persisted?.clientOptions;
    const restoredCleanShutdown = persisted?.cleanShutdown === true;

    this.savedSync = restoredSavedSync;
    this.savedClientOptions = restoredClientOptions;
    this.hadSavedSyncOnLoad = restoredSavedSync !== null;
    this.hadCleanShutdownOnLoad = this.hadSavedSyncOnLoad && restoredCleanShutdown;
    this.cleanShutdown = this.hadCleanShutdownOnLoad;

    if (this.savedSync) {
      this.accumulator.accumulate(syncDataToSyncResponse(this.savedSync), true);
      super.setSyncToken(this.savedSync.nextBatch);
    }
    if (this.savedClientOptions) {
      void super.storeClientOptions(this.savedClientOptions);
    }
  }

  hasSavedSync(): boolean {
    return this.hadSavedSyncOnLoad;
  }

  hasSavedSyncFromCleanShutdown(): boolean {
    return this.hadCleanShutdownOnLoad;
  }

  async bindSyncIngress(handler: MatrixSyncIngressHandler): Promise<() => void> {
    if (this.frozen || this.syncIngressHandler) {
      throw new Error("Matrix sync ingress is already bound or the sync store is frozen");
    }
    this.syncIngressHandler = handler;
    const dispose = () => {
      if (this.syncIngressHandler === handler) {
        this.syncIngressHandler = undefined;
      }
    };
    try {
      if (this.savedSync) {
        const cachedSync = syncDataToSyncResponse(this.savedSync);
        await this.runSyncIngress(() => handler(cachedSync, { hasSavedSync: true }));
      }
    } catch (error) {
      dispose();
      throw error;
    }
    return dispose;
  }

  override setSyncToken(token: string): void {
    // Classic sync assigns its next token before delivering events. Admission
    // owns that advance while bound, including in-memory retries after failure.
    if (!this.frozen && !this.syncIngressHandler) {
      super.setSyncToken(token);
    }
  }

  override getSavedSync(): Promise<ISyncData | null> {
    return Promise.resolve(this.savedSync ? structuredClone(this.savedSync) : null);
  }

  override getSavedSyncToken(): Promise<string | null> {
    return Promise.resolve(this.savedSync?.nextBatch ?? null);
  }

  override async setSyncData(syncData: ISyncResponse): Promise<void> {
    if (this.frozen) {
      return;
    }
    const handler = this.syncIngressHandler;
    if (handler) {
      await this.runSyncIngress(async () => {
        await handler(syncData, { hasSavedSync: this.hadSavedSyncOnLoad });
        if (!this.frozen) {
          super.setSyncToken(syncData.next_batch);
          this.acceptSyncData(syncData);
        }
      });
      return;
    }
    this.acceptSyncData(syncData);
  }

  private acceptSyncData(syncData: ISyncResponse): void {
    this.accumulator.accumulate(syncData);
    this.savedSync = this.accumulator.getJSON();
    this.markDirtyAndSchedulePersist();
  }

  private runSyncIngress(operation: () => Promise<void>): Promise<void> {
    const pending = Promise.resolve(this.syncIngressAdmission)
      .then(operation)
      .finally(() => {
        if (this.syncIngressAdmission === pending) {
          this.syncIngressAdmission = null;
        }
      });
    this.syncIngressAdmission = pending;
    return pending;
  }

  override getClientOptions() {
    return Promise.resolve(
      this.savedClientOptions ? structuredClone(this.savedClientOptions) : undefined,
    );
  }

  override storeClientOptions(options: IStoredClientOpts) {
    if (this.frozen) {
      return Promise.resolve();
    }
    this.savedClientOptions = structuredClone(options);
    void super.storeClientOptions(options);
    this.markDirtyAndSchedulePersist();
    return Promise.resolve();
  }

  override save(force = false) {
    if (force) {
      return this.flush();
    }
    return Promise.resolve();
  }

  override async deleteAllData(): Promise<void> {
    const store = this.requireStore();
    this.clearPersistTimer();
    this.dirty = false;
    await this.enqueuePersistence(async () => {
      await super.deleteAllData();
      this.savedSync = null;
      this.savedClientOptions = undefined;
      this.cleanShutdown = false;
      this.dirty = false;
      await deleteMatrixSyncCacheStateFromStore({
        storageRootDir: this.storageRootDir,
        store,
      });
    });
  }

  markCleanShutdown(): void {
    this.cleanShutdown = true;
    this.dirty = true;
  }

  async freezeSyncCursorPersistence(): Promise<void> {
    this.frozen = true;
    this.clearPersistTimer();
    await this.syncIngressAdmission;
    while (this.persistPromise) {
      await this.persistPromise;
    }
  }

  discardPendingSyncCursorPersistence(): void {
    this.frozen = true;
    this.clearPersistTimer();
    this.cleanShutdown = false;
    this.dirty = false;
  }

  async flush(): Promise<void> {
    this.clearPersistTimer();
    while (this.dirty || this.persistPromise) {
      if (this.dirty && !this.persistPromise) {
        void this.enqueuePersistence(() => this.persist());
      }
      await this.persistPromise;
    }
  }

  private clearPersistTimer(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
  }

  private markDirtyAndSchedulePersist(): void {
    if (this.frozen) {
      return;
    }
    this.cleanShutdown = false;
    this.dirty = true;
    if (this.persistTimer) {
      return;
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.flush().catch((err: unknown) => {
        LogService.warn("MatrixSyncCacheStore", "Failed to persist Matrix sync store:", err);
      });
    }, PERSIST_DEBOUNCE_MS);
    this.persistTimer.unref?.();
  }

  private async persist(): Promise<void> {
    const store = this.requireStore();
    this.dirty = false;
    const payload: PersistedMatrixSyncStore = {
      version: MATRIX_SYNC_CACHE_VERSION,
      savedSync: this.savedSync,
      cleanShutdown: this.cleanShutdown,
      ...(this.savedClientOptions ? { clientOptions: this.savedClientOptions } : {}),
    };
    try {
      await writeMatrixSyncCacheStateToStore({
        storageRootDir: this.storageRootDir,
        payload,
        store,
      });
      await claimCurrentTokenStorageState({ rootDir: this.storageRootDir });
    } catch (err) {
      this.dirty = true;
      throw err;
    }
  }

  private enqueuePersistence(operation: () => Promise<void>): Promise<void> {
    const pending = this.persistLock(operation).finally(() => {
      if (this.persistPromise === pending) {
        this.persistPromise = null;
      }
    });
    this.persistPromise = pending;
    return pending;
  }

  private requireStore(): PluginStateKeyedStore<MatrixSyncCacheRecord, 2> {
    if (this.store && this.storeUnavailableError == null) {
      return this.store;
    }
    throw new Error("Matrix sync cache SQLite store is unavailable; cannot persist sync state", {
      cause: this.storeUnavailableError,
    });
  }
}
