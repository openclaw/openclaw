import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  Filter,
  createClient as createMatrixJsClient,
  type IFilterDefinition,
  type MatrixClient as MatrixJsClient,
} from "matrix-js-sdk/lib/matrix.js";
import { VerificationMethod } from "matrix-js-sdk/lib/types.js";
import { captureChannelReadAuthority } from "openclaw/plugin-sdk/fetch-runtime";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { PinnedDispatcherPolicy } from "openclaw/plugin-sdk/ssrf-dispatcher";
import type { SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import { SqliteBackedMatrixSyncStore } from "../client/file-sync-store.js";
import { createMatrixJsSdkClientLogger } from "../client/logging.js";
import type { MatrixSnapshotStateRuntime } from "../crypto-state-store.js";
import { awaitMatrixStartupWithAbort, throwIfMatrixStartupAborted } from "../startup-abort.js";
import type { MatrixSyncState } from "../sync-state.js";
import {
  MATRIX_AUTOMATIC_REPAIR_BOOTSTRAP_OPTIONS,
  MATRIX_INITIAL_CRYPTO_BOOTSTRAP_OPTIONS,
  resolveMatrixLocalTimeoutMs,
  type MatrixOwnDeviceInfo,
  type MatrixOwnDeviceVerificationStatus,
} from "./client-support.js";
import { quiesceMatrixClientSync } from "./client-sync-quiesce.js";
import { waitForMatrixInitialSyncReady } from "./client-sync-ready.js";
import type { MatrixCryptoFacade } from "./crypto-facade.js";
import type { MatrixDecryptBridge } from "./decrypt-bridge.js";
import { matrixEventToRaw } from "./event-helpers.js";
import { MatrixAuthedHttpClient } from "./http-client.js";
import { MATRIX_IDB_PERSIST_INTERVAL_MS } from "./idb-persistence-lock.js";
import { LogService, noop } from "./logger.js";
import { MatrixMessageWireDispatchGuards } from "./message-wire-dispatch.js";
import { MatrixRecoveryKeyStore } from "./recovery-key-store.js";
import { createMatrixGuardedFetch } from "./transport.js";
import type { MatrixClientEventMap, MatrixCryptoBootstrapApi, MatrixRawEvent } from "./types.js";
import type { MatrixVerificationSummary } from "./verification-manager.js";

type MatrixCryptoRuntime = typeof import("./crypto-runtime.js");

const MATRIX_ENCRYPTED_STARTUP_TIMEOUT_MS = 60_000;

let loadedMatrixCryptoRuntime: MatrixCryptoRuntime | null = null;

export const loadMatrixCryptoRuntime = createLazyRuntimeModule(() =>
  import("./crypto-runtime.js").then((runtime) => {
    loadedMatrixCryptoRuntime = runtime;
    return runtime;
  }),
);

export abstract class MatrixClientBase {
  abstract getUserId(): Promise<string>;
  abstract getJoinedRooms(): Promise<string[]>;
  abstract listOwnDevices(): Promise<MatrixOwnDeviceInfo[]>;
  abstract getOwnDeviceVerificationStatus(): Promise<MatrixOwnDeviceVerificationStatus>;
  abstract getRoomStateEvent(
    roomId: string,
    eventType: string,
    stateKey?: string,
  ): Promise<Record<string, unknown>>;
  abstract getMessageWireEventType(roomId: string): Promise<"m.room.message" | "m.room.encrypted">;
  abstract downloadContent(
    mxcUrl: string,
    opts?: { allowRemote?: boolean; maxBytes?: number; readIdleTimeoutMs?: number },
  ): Promise<Buffer>;
  protected abstract registerBridge(): void;
  protected abstract emitOutstandingInviteEvents(): void;
  protected abstract refreshDmCache(): Promise<boolean>;

  protected readonly client: MatrixJsClient;
  protected readonly emitter = new EventEmitter();
  protected readonly httpClient: MatrixAuthedHttpClient;
  protected readonly localTimeoutMs: number;
  protected readonly initialSyncLimit?: number;
  protected readonly syncFilter?: IFilterDefinition;
  protected readonly encryptionEnabled: boolean;
  protected readonly password?: string;
  protected readonly syncStore?: SqliteBackedMatrixSyncStore;
  protected readonly idbSnapshotPath?: string;
  protected readonly cryptoDatabasePrefix?: string;
  protected readonly stateRuntime?: MatrixSnapshotStateRuntime;
  protected bridgeRegistered = false;
  protected started = false;
  protected cryptoBootstrapped = false;
  protected selfUserId: string | null;
  protected readonly dmRoomIds = new Set<string>();
  protected cryptoInitialized = false;
  protected decryptBridge?: MatrixDecryptBridge<MatrixRawEvent>;
  protected verificationManager?: import("./verification-manager.js").MatrixVerificationManager;
  protected readonly sendQueue = new KeyedAsyncQueue();
  protected readonly recoveryKeyStore: MatrixRecoveryKeyStore;
  protected cryptoBootstrapper?:
    | import("./crypto-bootstrap.js").MatrixCryptoBootstrapper<MatrixRawEvent>
    | undefined;
  protected readonly autoBootstrapCrypto: boolean;
  protected syncQuiescePromise: Promise<void> | null = null;
  protected stopPersistPromise: Promise<void> | null = null;
  protected verificationSummaryListenerBound = false;
  protected currentSyncState: MatrixSyncState | null = null;
  protected currentSyncError: unknown = undefined;
  protected readonly transactionScopeHomeserver: string;
  protected readonly transactionScopeAccessTokenHash: string;
  protected transactionScopeDeviceId: string | null;
  protected transactionScopeId: string | null = null;
  protected transactionScopePromise: Promise<string> | null = null;
  protected readonly messageWireDispatchGuards = new MatrixMessageWireDispatchGuards();
  private readonly requestAbortController = new AbortController();
  private readonly cryptoRequestOwner = new AsyncLocalStorage<{
    callerAuthority: (() => void) | undefined;
    requestSignal?: AbortSignal;
  }>();
  private startupPromise: Promise<void> | null = null;
  private cryptoInitializationPromise: Promise<void> | null = null;
  private sdkStopped = false;
  private stopDiscardPromise: Promise<void> | null = null;
  private idbPersistPromise: Promise<void> | null = null;
  private idbPersistAbortController: AbortController | null = null;

  private readonly assertClientActive = () => {
    this.requestAbortController.signal.throwIfAborted();
  };

  private readonly captureRequestAuthority = (): (() => void) | undefined => {
    const readAuthority = captureChannelReadAuthority();
    const cryptoOwner = this.cryptoRequestOwner.getStore();
    // A new read inside an SDK callback owns its own host scope.
    return cryptoOwner && cryptoOwner.callerAuthority === readAuthority
      ? this.assertClientActive
      : readAuthority;
  };

  private withClientCryptoWork<T>(run: () => T, requestSignal?: AbortSignal): T {
    this.assertClientActive();
    return this.cryptoRequestOwner.run(
      { callerAuthority: captureChannelReadAuthority(), requestSignal },
      run,
    );
  }

  readonly dms = {
    update: async (): Promise<boolean> => {
      return await this.refreshDmCache();
    },
    isDm: (roomId: string): boolean => this.dmRoomIds.has(roomId),
  };

  crypto?: MatrixCryptoFacade;

  constructor(
    homeserver: string,
    accessToken: string,
    opts: {
      userId?: string;
      password?: string;
      deviceId?: string;
      localTimeoutMs?: number;
      encryption?: boolean;
      initialSyncLimit?: number;
      syncFilter?: IFilterDefinition;
      storageRootDir?: string;
      recoveryKeyPath?: string;
      idbSnapshotPath?: string;
      cryptoDatabasePrefix?: string;
      autoBootstrapCrypto?: boolean;
      ssrfPolicy?: SsrFPolicy;
      dispatcherPolicy?: PinnedDispatcherPolicy;
      stateRuntime?: MatrixSnapshotStateRuntime;
    } = {},
  ) {
    this.transactionScopeHomeserver = homeserver;
    this.transactionScopeAccessTokenHash = createHash("sha256").update(accessToken).digest("hex");
    this.transactionScopeDeviceId = opts.deviceId?.trim() || null;
    this.httpClient = new MatrixAuthedHttpClient({
      homeserver,
      accessToken,
      ssrfPolicy: opts.ssrfPolicy,
      dispatcherPolicy: opts.dispatcherPolicy,
      captureRequestAuthority: this.captureRequestAuthority,
      signal: this.requestAbortController.signal,
    });
    this.localTimeoutMs = resolveMatrixLocalTimeoutMs(opts.localTimeoutMs);
    this.initialSyncLimit = opts.initialSyncLimit;
    this.syncFilter = opts.syncFilter;
    this.encryptionEnabled = opts.encryption === true;
    const { password: loginPassword } = opts;
    this.password = loginPassword;
    this.syncStore = opts.storageRootDir
      ? new SqliteBackedMatrixSyncStore(opts.storageRootDir)
      : undefined;
    this.idbSnapshotPath = opts.idbSnapshotPath;
    this.cryptoDatabasePrefix = opts.cryptoDatabasePrefix;
    this.stateRuntime = opts.stateRuntime;
    this.selfUserId = opts.userId?.trim() || null;
    this.autoBootstrapCrypto = opts.autoBootstrapCrypto !== false;
    this.recoveryKeyStore = new MatrixRecoveryKeyStore(opts.recoveryKeyPath, opts.stateRuntime);
    const cryptoCallbacks = this.encryptionEnabled
      ? this.recoveryKeyStore.buildCryptoCallbacks()
      : undefined;
    const guardedFetch = createMatrixGuardedFetch({
      captureRequestSignal: () => this.cryptoRequestOwner.getStore()?.requestSignal,
      ssrfPolicy: opts.ssrfPolicy,
      dispatcherPolicy: opts.dispatcherPolicy,
      captureRequestAuthority: this.captureRequestAuthority,
      signal: this.requestAbortController.signal,
      beforeRequest: async (resource, init) => {
        // Complete admitted key persistence before checking live wire authority.
        await this.recoveryKeyStore.drainPendingPersistence();
        await this.messageWireDispatchGuards.beforeRequest(resource, init);
      },
    });
    this.client = createMatrixJsClient({
      baseUrl: homeserver,
      accessToken,
      userId: opts.userId,
      deviceId: opts.deviceId,
      logger: createMatrixJsSdkClientLogger("MatrixClient"),
      localTimeoutMs: this.localTimeoutMs,
      fetchFn: guardedFetch,
      store: this.syncStore,
      cryptoCallbacks: cryptoCallbacks as never,
      verificationMethods: [
        VerificationMethod.Sas,
        VerificationMethod.ShowQrCode,
        VerificationMethod.ScanQrCode,
        VerificationMethod.Reciprocate,
      ],
    });
    // SDK mappers and relations also call this method. Crypto retries belong to
    // the client generation, while their callers retain their own read authority.
    const decryptEventIfNeeded = this.client.decryptEventIfNeeded.bind(this.client);
    this.client.decryptEventIfNeeded = (event, options) => {
      this.captureRequestAuthority()?.();
      return this.withClientCryptoWork(() => decryptEventIfNeeded(event, options));
    };
  }

  on<TEvent extends keyof MatrixClientEventMap>(
    eventName: TEvent,
    listener: (...args: MatrixClientEventMap[TEvent]) => void,
  ): this;
  on(eventName: string, listener: (...args: unknown[]) => void): this;
  on(eventName: string, listener: (...args: unknown[]) => void): this {
    this.emitter.on(eventName, listener as (...args: unknown[]) => void);
    return this;
  }

  off<TEvent extends keyof MatrixClientEventMap>(
    eventName: TEvent,
    listener: (...args: MatrixClientEventMap[TEvent]) => void,
  ): this;
  off(eventName: string, listener: (...args: unknown[]) => void): this;
  off(eventName: string, listener: (...args: unknown[]) => void): this {
    this.emitter.off(eventName, listener as (...args: unknown[]) => void);
    return this;
  }

  protected idbPersistTimer: ReturnType<typeof setInterval> | null = null;

  protected async ensureCryptoSupportInitialized(): Promise<void> {
    if (
      this.decryptBridge &&
      (!this.encryptionEnabled ||
        (this.verificationManager && this.cryptoBootstrapper && this.crypto))
    ) {
      return;
    }

    const runtime = await loadMatrixCryptoRuntime();
    this.decryptBridge ??= new runtime.MatrixDecryptBridge<MatrixRawEvent>({
      client: this.client,
      toRaw: (event) => matrixEventToRaw(event, { contentMode: "original" }),
      emitDecryptedEvent: (roomId, event) => {
        this.emitter.emit("room.decrypted_event", roomId, event);
      },
      emitMessage: (roomId, event) => {
        this.emitter.emit("room.message", roomId, event);
      },
      emitFailedDecryption: (roomId, event, error) => {
        this.emitter.emit("room.failed_decryption", roomId, event, error);
      },
    });
    if (!this.encryptionEnabled) {
      return;
    }

    this.verificationManager ??= new runtime.MatrixVerificationManager({
      trustOwnDeviceAfterSas: async (deviceId: string) => {
        const crypto = this.client.getCrypto() as MatrixCryptoBootstrapApi | undefined;
        if (typeof crypto?.crossSignDevice !== "function") {
          return;
        }
        await crypto.crossSignDevice(deviceId);
      },
    });
    this.cryptoBootstrapper ??= new runtime.MatrixCryptoBootstrapper<MatrixRawEvent>({
      getUserId: () => this.getUserId(),
      getPassword: () => this.password,
      canUnlockSecretStorage: async () => {
        const secretStorage = (
          this.client as {
            secretStorage?: Partial<
              Pick<MatrixJsClient["secretStorage"], "checkKey" | "getDefaultKeyId" | "getKey">
            >;
          }
        ).secretStorage;
        // Partial test/runtime facades can omit secretStorage; forced reset must fail closed
        // without turning missing recovery access into a noisy caught TypeError.
        if (
          !secretStorage ||
          typeof secretStorage.getDefaultKeyId !== "function" ||
          typeof secretStorage.getKey !== "function" ||
          typeof secretStorage.checkKey !== "function"
        ) {
          return false;
        }
        const defaultKeyId = await secretStorage.getDefaultKeyId();
        if (!defaultKeyId) {
          return false;
        }
        const keyTuple = await secretStorage.getKey(defaultKeyId);
        const key = await this.recoveryKeyStore.getSecretStorageKeyCandidate(defaultKeyId);
        if (!keyTuple || !key) {
          return false;
        }
        const keyInfo = keyTuple[1];
        if (!keyInfo.iv?.trim() || !keyInfo.mac?.trim()) {
          return false;
        }
        return await secretStorage.checkKey(key, keyInfo);
      },
      getDeviceId: () => this.client.getDeviceId(),
      verificationManager: this.verificationManager,
      recoveryKeyStore: this.recoveryKeyStore,
      decryptBridge: this.decryptBridge,
    });
    if (!this.crypto) {
      this.crypto = runtime.createMatrixCryptoFacade({
        client: this.client,
        verificationManager: this.verificationManager,
        recoveryKeyStore: this.recoveryKeyStore,
        isRoomEncrypted: async (roomId) =>
          (await this.getMessageWireEventType(roomId)) === "m.room.encrypted",
        downloadContent: (mxcUrl, opts) => this.downloadContent(mxcUrl, opts),
      });
    }
    if (!this.verificationSummaryListenerBound) {
      this.verificationSummaryListenerBound = true;
      this.verificationManager.onSummaryChanged((summary: MatrixVerificationSummary) => {
        this.emitter.emit("verification.summary", summary);
      });
    }
  }

  async start(opts: { abortSignal?: AbortSignal; readyTimeoutMs?: number } = {}): Promise<void> {
    await this.startSyncSession({
      bootstrapCrypto: true,
      abortSignal: opts.abortSignal,
      readyTimeoutMs: opts.readyTimeoutMs,
    });
  }

  protected async waitForInitialSyncReady(
    params: {
      timeoutMs?: number;
      abortSignal?: AbortSignal;
    } = {},
  ): Promise<void> {
    await waitForMatrixInitialSyncReady({
      ...params,
      emitter: this.emitter,
      state: this.currentSyncState,
      error: this.currentSyncError,
    });
  }

  protected async startSyncSession(opts: {
    bootstrapCrypto: boolean;
    abortSignal?: AbortSignal;
    readyTimeoutMs?: number;
  }): Promise<void> {
    if (this.started) {
      return;
    }
    if (this.sdkStopped) {
      throw new Error(
        "Matrix client has been fully stopped and cannot be restarted; acquire a new shared client generation",
      );
    }
    const assertCurrent = this.captureRequestAuthority();
    assertCurrent?.();
    this.assertClientActive();

    if (this.startupPromise) {
      await awaitMatrixStartupWithAbort(this.startupPromise, opts.abortSignal);
      return;
    }
    const deadline = new AbortController();
    const signal = AbortSignal.any([
      this.requestAbortController.signal,
      deadline.signal,
      ...(opts.abortSignal ? [opts.abortSignal] : []),
    ]);
    const timeout = this.encryptionEnabled
      ? setTimeout(
          () => deadline.abort(),
          opts.readyTimeoutMs ?? MATRIX_ENCRYPTED_STARTUP_TIMEOUT_MS,
        )
      : undefined;
    timeout?.unref?.();
    const checkActive = () => {
      throwIfMatrixStartupAborted(signal);
      assertCurrent?.();
      this.assertClientActive();
    };
    const startup = (async () => {
      throwIfMatrixStartupAborted(signal);
      await this.ensureCryptoSupportInitialized();
      checkActive();
      throwIfMatrixStartupAborted(signal);
      this.registerBridge();
      await this.withClientCryptoWork(() => this.initializeCryptoIfNeeded(signal), signal);
      checkActive();
      throwIfMatrixStartupAborted(signal);

      await this.withClientCryptoWork(() =>
        this.client.startClient({
          initialSyncLimit: this.initialSyncLimit,
          ...(this.syncFilter
            ? { filter: Filter.fromJson(this.selfUserId, "", this.syncFilter) }
            : {}),
        }),
      );
      await this.waitForInitialSyncReady({
        abortSignal: signal,
        timeoutMs: opts.readyTimeoutMs,
      });
      checkActive();
      throwIfMatrixStartupAborted(signal);
      if (this.encryptionEnabled && this.cryptoInitialized) {
        const { reconcileJoinedRoomEncryption } = await import("./joined-room-encryption.js");
        checkActive();
        await this.withClientCryptoWork(
          () => reconcileJoinedRoomEncryption(this.client, signal, checkActive),
          signal,
        );
        checkActive();
      }
      clearTimeout(timeout);
      if (opts.bootstrapCrypto && this.autoBootstrapCrypto) {
        await this.bootstrapCryptoIfNeeded(signal);
      }
      throwIfMatrixStartupAborted(signal);
      this.started = true;
      this.emitOutstandingInviteEvents();
      await this.refreshDmCache().catch(noop);
    })();
    this.startupPromise = startup;
    // Caller cancellation is prompt, but shutdown still owns and joins the real
    // work: Rust initialization/replay can settle after the caller has left.
    void startup
      .finally(() => {
        clearTimeout(timeout);
        if (this.startupPromise === startup) {
          this.startupPromise = null;
        }
      })
      .catch(noop);
    await awaitMatrixStartupWithAbort(startup, signal);
  }

  async prepareForOneOff(): Promise<void> {
    const assertCurrent = this.captureRequestAuthority();
    assertCurrent?.();
    this.assertClientActive();
    if (!this.encryptionEnabled) {
      return;
    }
    await this.ensureCryptoSupportInitialized();
    assertCurrent?.();
    await this.withClientCryptoWork(() => this.initializeCryptoIfNeeded());
    assertCurrent?.();
    // One-off verification initializes crypto only. Room hydration belongs to
    // startSyncSession, after sync has created real Room objects.
  }

  hasPersistedSyncState(): boolean {
    // Only trust restart replay when the previous process completed a final
    // sync-store persist. A stale cursor can make Matrix re-surface old events.
    return this.syncStore?.hasSavedSyncFromCleanShutdown() === true;
  }

  protected async ensureStartedForCryptoControlPlane(): Promise<void> {
    if (this.started) {
      return;
    }
    await this.startSyncSession({ bootstrapCrypto: false });
  }

  private stopSdkClient(): void {
    if (this.sdkStopped) {
      return;
    }
    this.currentSyncState = null;
    this.currentSyncError = undefined;
    this.sdkStopped = true;
    this.client.stopClient();
    this.started = false;
  }

  async quiesceSync(): Promise<void> {
    // Quiescence is terminal for a client generation. Memoize both success and
    // failure so an untrusted cursor can never be persisted by a later retry.
    this.syncQuiescePromise ??= quiesceMatrixClientSync({
      client: this.client,
      emitter: this.emitter,
      markStopped: () => {
        this.started = false;
      },
      started: this.started,
      syncStore: this.syncStore,
    });
    await this.syncQuiescePromise;
  }

  async drainPendingDecryptions(reason = "matrix client shutdown"): Promise<void> {
    await this.withClientCryptoWork(() => this.decryptBridge?.drainPendingDecryptions(reason));
  }

  stop(): void {
    void this.stopAndPersist()
      .catch(() => this.stopWithoutPersist())
      .catch(noop);
  }

  private async stopClientGeneration(persist: boolean): Promise<void> {
    try {
      if (persist) {
        await this.quiesceSync();
      } else {
        await this.quiesceSync().catch(noop);
        this.syncStore?.discardPendingSyncCursorPersistence();
      }
      this.requestAbortController.abort(new Error("Matrix client generation is no longer active."));
      // A one-off read can still be preparing crypto when its owner closes.
      // Join that initialization before stopping the backend it may publish.
      await this.startupPromise?.catch(noop);
      await this.cryptoInitializationPromise?.catch(noop);
      clearInterval(this.idbPersistTimer ?? undefined);
      this.idbPersistTimer = null;
      this.idbPersistAbortController?.abort();
      const activePeriodicPersist = this.idbPersistPromise;
      try {
        this.stopSdkClient();
        this.decryptBridge?.stop();
      } finally {
        this.cryptoRequestOwner.disable();
      }
      await Promise.all([this.recoveryKeyStore.close(), activePeriodicPersist]);
      if (persist) {
        const runtime = loadedMatrixCryptoRuntime ?? (await loadMatrixCryptoRuntime());
        await runtime.persistIdbToDisk({
          snapshotPath: this.idbSnapshotPath,
          databasePrefix: this.cryptoDatabasePrefix,
          strict: true,
          stateRuntime: this.stateRuntime,
        });
        this.syncStore?.markCleanShutdown();
        await this.syncStore?.flush();
      }
    } finally {
      await this.recoveryKeyStore.close();
    }
  }

  async stopAndPersist(): Promise<void> {
    this.stopPersistPromise ??= this.stopClientGeneration(true);
    await this.stopPersistPromise;
  }

  stopWithoutPersist(): Promise<void> {
    // Memoization closes concurrent callers; durable failure still requires discard cleanup.
    if (!this.stopPersistPromise) {
      this.stopPersistPromise = this.stopDiscardPromise = this.stopClientGeneration(false);
    }
    return (this.stopDiscardPromise ??= this.stopPersistPromise.catch(() =>
      this.stopClientGeneration(false),
    ));
  }

  protected async bootstrapCryptoIfNeeded(abortSignal?: AbortSignal): Promise<void> {
    if (!this.encryptionEnabled || !this.cryptoInitialized || this.cryptoBootstrapped) {
      return;
    }
    throwIfMatrixStartupAborted(abortSignal);
    await this.ensureCryptoSupportInitialized();
    const crypto = this.client.getCrypto() as MatrixCryptoBootstrapApi | undefined;
    if (!crypto) {
      return;
    }
    const cryptoBootstrapper = this.cryptoBootstrapper;
    if (!cryptoBootstrapper) {
      return;
    }
    const initial = await cryptoBootstrapper.bootstrap(
      crypto,
      MATRIX_INITIAL_CRYPTO_BOOTSTRAP_OPTIONS,
    );
    throwIfMatrixStartupAborted(abortSignal);
    if (!initial.crossSigningPublished || initial.ownDeviceVerified === false) {
      const status = await this.getOwnDeviceVerificationStatus();
      if (status.signedByOwner) {
        LogService.warn(
          "MatrixClientLite",
          "Cross-signing/bootstrap is incomplete for an already owner-signed device; skipping automatic reset and preserving the current identity. Restore the recovery key or run an explicit verification bootstrap if repair is needed.",
        );
      } else {
        // Forced reset validates the active SSSS recovery key before rotating local keys.
        // Missing or stale recovery material fails without mutating crypto state.
        try {
          const repaired = await cryptoBootstrapper.bootstrap(
            crypto,
            MATRIX_AUTOMATIC_REPAIR_BOOTSTRAP_OPTIONS,
          );
          throwIfMatrixStartupAborted(abortSignal);
          if (repaired.crossSigningPublished && repaired.ownDeviceVerified !== false) {
            LogService.info(
              "MatrixClientLite",
              "Cross-signing/bootstrap recovered after forced reset",
            );
          }
        } catch (err) {
          LogService.warn(
            "MatrixClientLite",
            "Failed to recover cross-signing/bootstrap with forced reset:",
            err,
          );
        }
      }
    }
    this.cryptoBootstrapped = true;
  }

  protected async initializeCryptoIfNeeded(abortSignal?: AbortSignal): Promise<void> {
    if (!this.encryptionEnabled) {
      return;
    }
    if (this.cryptoInitializationPromise) {
      await this.cryptoInitializationPromise;
      throwIfMatrixStartupAborted(abortSignal);
      return;
    }
    if (this.cryptoInitialized) {
      return;
    }
    const initialization = this.initializeCrypto(
      abortSignal
        ? AbortSignal.any([abortSignal, this.requestAbortController.signal])
        : this.requestAbortController.signal,
    );
    this.cryptoInitializationPromise = initialization;
    try {
      await initialization;
    } finally {
      if (this.cryptoInitializationPromise === initialization) {
        this.cryptoInitializationPromise = null;
      }
    }
  }

  private async initializeCrypto(abortSignal: AbortSignal): Promise<void> {
    throwIfMatrixStartupAborted(abortSignal);
    const { persistIdbToDisk, restoreIdbFromDisk } = await loadMatrixCryptoRuntime();

    // Restore persisted IndexedDB crypto store before initializing WASM crypto.
    await restoreIdbFromDisk(this.idbSnapshotPath, this.stateRuntime);
    throwIfMatrixStartupAborted(abortSignal);

    try {
      await this.client.initRustCrypto({
        cryptoDatabasePrefix: this.cryptoDatabasePrefix,
      });
      this.cryptoInitialized = true;
      throwIfMatrixStartupAborted(abortSignal);

      // Persist the crypto store after successful init (captures fresh keys on first run).
      await persistIdbToDisk({
        snapshotPath: this.idbSnapshotPath,
        databasePrefix: this.cryptoDatabasePrefix,
        abortSignal,
        stateRuntime: this.stateRuntime,
      });
      throwIfMatrixStartupAborted(abortSignal);

      // Periodically persist to capture new Olm sessions and room keys.
      this.idbPersistTimer = setInterval(() => {
        if (this.idbPersistPromise) {
          return;
        }
        const abortController = new AbortController();
        this.idbPersistAbortController = abortController;
        this.idbPersistPromise = persistIdbToDisk({
          snapshotPath: this.idbSnapshotPath,
          databasePrefix: this.cryptoDatabasePrefix,
          abortSignal: abortController.signal,
          stateRuntime: this.stateRuntime,
        })
          .catch(noop)
          .finally(() => {
            this.idbPersistPromise = null;
            this.idbPersistAbortController = null;
          });
      }, MATRIX_IDB_PERSIST_INTERVAL_MS);
      this.idbPersistTimer.unref?.();
    } catch (err) {
      throwIfMatrixStartupAborted(abortSignal);
      LogService.warn("MatrixClientLite", "Failed to initialize rust crypto:", err);
    }
  }
}
