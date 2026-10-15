import type { GroupMetadata, WASocket, WAMessageKey, proto } from "baileys";
import { registerChannelRuntimeContext } from "openclaw/plugin-sdk/channel-runtime-context";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { info } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { racePromiseWithAbortSignal } from "openclaw/plugin-sdk/time-runtime";
import {
  WHATSAPP_CONNECTION_CONTROLLER_CAPABILITY,
  WHATSAPP_CONNECTION_OWNER_PENDING_CAPABILITY,
} from "./connection-controller-runtime-context.js";
import {
  acquireWhatsAppGatewayConnectionOwner,
  type WhatsAppGatewayConnectionOwnerLease,
} from "./connection-owner.js";
import { resolveComparableIdentity, type WhatsAppSelfIdentity } from "./identity.js";
import type { ActiveWebListener, WebListenerCloseReason } from "./inbound/types.js";
import { computeBackoff, sleepWithAbort, type ReconnectPolicy } from "./reconnect.js";
import { getWhatsAppChannelRuntime } from "./runtime.js";
import {
  createWaSocket,
  formatError,
  getStatusCode,
  logoutWeb,
  readWebAuthExistsForDecision,
  waitForCredsSaveQueueWithTimeout,
  waitForWaConnection,
  WhatsAppAuthUnstableError,
} from "./session.js";
import { closeWaSocket, closeWhatsAppSocketAndWait } from "./socket-close.js";
import {
  DEFAULT_WHATSAPP_SOCKET_TIMING,
  type WhatsAppSocketTimingOptions,
} from "./socket-timing.js";

const LOGGED_OUT_STATUS = 401;
const POST_PAIRING_RESTART_STATUS = 515;
const TIMED_OUT_STATUS = 408;
const WHATSAPP_LOGIN_RESTART_MESSAGE =
  "WhatsApp asked for a restart after pairing (code 515); waiting for creds to save…";
const WHATSAPP_LOGIN_TIMEOUT_RESTART_MESSAGE =
  "WhatsApp connection timed out before login; retrying with a fresh socket…";
const WHATSAPP_LOGGED_OUT_RELINK_MESSAGE =
  "WhatsApp reported the session is logged out. Cleared cached web session; please rerun openclaw channels login and scan the QR again.";
const WHATSAPP_LOGIN_AUTH_UNSTABLE_MESSAGE =
  "WhatsApp connected, but saving the linked credentials has not settled on disk yet. Retry login in a moment.";
const WHATSAPP_LOGIN_AUTH_NOT_PERSISTED_MESSAGE =
  "WhatsApp connected, but the linked credentials were not found on disk. Retry login in a moment.";
const WHATSAPP_LOGIN_AUTH_NOT_CLEARED_MESSAGE =
  "existing auth could not be cleared. Remove or fix the configured WhatsApp auth directory, then retry login.";
export const WHATSAPP_LOGGED_OUT_QR_MESSAGE =
  "WhatsApp reported the session is logged out. Cleared cached web session; please scan a new QR.";
export const WHATSAPP_WATCHDOG_TIMEOUT_ERROR = "watchdog-timeout";

type TimerHandle = ReturnType<typeof setInterval>;
type WaSocket = Awaited<ReturnType<typeof createWaSocket>>;

export type ManagedWhatsAppListener = ActiveWebListener & {
  onClose?: Promise<WebListenerCloseReason>;
  signalClose?: (reason?: WebListenerCloseReason) => void;
};

type WhatsAppLiveConnection = {
  connectionId: string;
  startedAt: number;
  sock: WASocket;
  listener: ManagedWhatsAppListener;
  heartbeat: TimerHandle | null;
  watchdogTimer: TimerHandle | null;
  lastInboundAt: number | null;
  lastTransportActivityAt: number;
  handledMessages: number;
  unregisterUnhandled: (() => void) | null;
  unregisterTransportActivity: (() => void) | null;
  openedAfterRecentInbound: boolean;
  backgroundTasks: Set<Promise<unknown>>;
  closePromise: Promise<WebListenerCloseReason>;
  resolveClose: (reason: WebListenerCloseReason) => void;
  socketClosed: boolean;
};

type WhatsAppSocketCleanup = Pick<WhatsAppLiveConnection, "sock" | "socketClosed">;

type WhatsAppOpenConnectionParams = {
  connectionId: string;
  createListener: (context: {
    sock: WASocket;
    connection: WhatsAppLiveConnection;
  }) => Promise<ManagedWhatsAppListener>;
  onHeartbeat?: (snapshot: WhatsAppConnectionSnapshot) => void;
  onWatchdogTimeout?: (snapshot: WhatsAppConnectionSnapshot) => void;
  getMessage?: (key: WAMessageKey) => Promise<proto.IMessage | undefined>;
  cachedGroupMetadata?: (jid: string) => Promise<GroupMetadata | undefined>;
};

type WhatsAppConnectionSnapshot = {
  connectionId: string;
  startedAt: number;
  lastInboundAt: number | null;
  lastTransportActivityAt: number;
  handledMessages: number;
  reconnectAttempts: number;
  uptimeMs: number;
};

type NormalizedConnectionCloseReason = {
  statusCode?: number;
  statusLabel: number | "unknown";
  isLoggedOut: boolean;
  error?: unknown;
  errorText: string;
};

type WhatsAppConnectionCloseDecision = {
  action: "stop" | "retry";
  delayMs?: number;
  reconnectAttempts: number;
  healthState: "logged-out" | "conflict" | "stopped" | "reconnecting";
  normalized: NormalizedConnectionCloseReason;
};

type WhatsAppReconnectAttemptDecision = {
  action: "stop" | "retry";
  delayMs?: number;
  reconnectAttempts: number;
  healthState: "stopped" | "reconnecting";
};

function createNeverResolvePromise<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

type SocketActivityEmitter = {
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  off?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
};

function stoppedControllerError(): Error {
  return new Error("WhatsApp connection controller is shutting down");
}

type WhatsAppLoginWaitResult =
  | {
      outcome: "connected";
      restarted: boolean;
      sock: WaSocket;
    }
  | {
      outcome: "logged-out";
      message: string;
      statusCode: number;
      error: unknown;
    }
  | {
      outcome: "failed";
      message: string;
      statusCode?: number;
      error: unknown;
    };

type CredentialPersistenceFailure = { error: unknown };

async function waitForLoginSocket(params: {
  wait: () => Promise<void>;
  credentialPersistenceFailure?: Promise<CredentialPersistenceFailure>;
}): Promise<void> {
  if (!params.credentialPersistenceFailure) {
    await params.wait();
    return;
  }
  const outcome = await Promise.race([
    params.wait().then(() => ({ kind: "connected" }) as const),
    params.credentialPersistenceFailure.then((failure) => ({
      kind: "credential-persistence-failed" as const,
      failure,
    })),
  ]);
  if (outcome.kind === "credential-persistence-failed") {
    throw outcome.failure.error;
  }
}

function throwIfCredentialPersistenceFailed(
  getFailure?: () => CredentialPersistenceFailure | null,
): void {
  const failure = getFailure?.();
  if (failure) {
    throw failure.error;
  }
}

export async function waitForWhatsAppLoginResult(params: {
  sock: WaSocket;
  authDir: string;
  isLegacyAuthDir: boolean;
  verbose: boolean;
  runtime: RuntimeEnv;
  waitForConnection?: typeof waitForWaConnection;
  createSocket?: typeof createWaSocket;
  socketTiming?: WhatsAppSocketTimingOptions;
  onQr?: (qr: string) => void;
  onSocketReplaced?: (sock: WaSocket) => void;
  beforeCredentialPersistence?: () => Promise<void>;
  onCredentialPersistenceError?: (error: unknown) => void;
  onCredentialPersistenceTask?: (task: Promise<unknown>) => void;
  waitForCredentialPersistence?: () => Promise<void>;
  credentialPersistenceFailure?: Promise<CredentialPersistenceFailure>;
  getCredentialPersistenceFailure?: () => CredentialPersistenceFailure | null;
}): Promise<WhatsAppLoginWaitResult> {
  const wait = params.waitForConnection ?? waitForWaConnection;
  const createSocket = params.createSocket ?? createWaSocket;
  let currentSock = params.sock;
  const restartedStatuses = new Set<number>();

  const replaceLoginSocket = async (): Promise<WhatsAppLoginWaitResult | null> => {
    try {
      currentSock = await createSocket(false, params.verbose, {
        authDir: params.authDir,
        ...params.socketTiming,
        onQr: params.onQr,
        beforeCredentialPersistence: params.beforeCredentialPersistence,
        onCredentialPersistenceError: params.onCredentialPersistenceError,
        onCredentialPersistenceTask: params.onCredentialPersistenceTask,
      });
      params.onSocketReplaced?.(currentSock);
      return null;
    } catch (createErr) {
      return {
        outcome: "failed",
        message: formatError(createErr),
        statusCode: getStatusCode(createErr),
        error: createErr,
      };
    }
  };

  while (true) {
    try {
      await waitForLoginSocket({
        wait: async () => await wait(currentSock, { timeout: "none" }),
        credentialPersistenceFailure: params.credentialPersistenceFailure,
      });
      await params.waitForCredentialPersistence?.();
      throwIfCredentialPersistenceFailed(params.getCredentialPersistenceFailure);
      // Socket open only proves in-memory auth; require persisted creds before success.
      const persistedAuth = await readWebAuthExistsForDecision(params.authDir);
      throwIfCredentialPersistenceFailed(params.getCredentialPersistenceFailure);
      if (persistedAuth.outcome === "unstable") {
        return {
          outcome: "failed",
          message: WHATSAPP_LOGIN_AUTH_UNSTABLE_MESSAGE,
          error: new WhatsAppAuthUnstableError(WHATSAPP_LOGIN_AUTH_UNSTABLE_MESSAGE),
        };
      }
      if (!persistedAuth.exists) {
        return {
          outcome: "failed",
          message: WHATSAPP_LOGIN_AUTH_NOT_PERSISTED_MESSAGE,
          error: new WhatsAppAuthUnstableError(WHATSAPP_LOGIN_AUTH_NOT_PERSISTED_MESSAGE),
        };
      }
      return {
        outcome: "connected",
        restarted: restartedStatuses.size > 0,
        sock: currentSock,
      };
    } catch (err) {
      const statusCode = getStatusCode(err);
      if (
        (statusCode === POST_PAIRING_RESTART_STATUS || statusCode === TIMED_OUT_STATUS) &&
        !restartedStatuses.has(statusCode)
      ) {
        restartedStatuses.add(statusCode);
        params.runtime.log(
          info(
            statusCode === TIMED_OUT_STATUS
              ? WHATSAPP_LOGIN_TIMEOUT_RESTART_MESSAGE
              : WHATSAPP_LOGIN_RESTART_MESSAGE,
          ),
        );
        closeWaSocket(currentSock);
      } else if (statusCode === LOGGED_OUT_STATUS) {
        if (restartedStatuses.has(LOGGED_OUT_STATUS)) {
          return {
            outcome: "logged-out",
            message: WHATSAPP_LOGGED_OUT_RELINK_MESSAGE,
            statusCode: LOGGED_OUT_STATUS,
            error: err,
          };
        }
        closeWaSocket(currentSock);
        const cleared = await logoutWeb({
          authDir: params.authDir,
          isLegacyAuthDir: params.isLegacyAuthDir,
          runtime: params.runtime,
          beforeCredentialPersistence: params.beforeCredentialPersistence,
        });
        if (!cleared) {
          const existingAuth = await readWebAuthExistsForDecision(params.authDir);
          if (existingAuth.outcome === "unstable") {
            return {
              outcome: "failed",
              message: WHATSAPP_LOGIN_AUTH_UNSTABLE_MESSAGE,
              error: new WhatsAppAuthUnstableError(WHATSAPP_LOGIN_AUTH_UNSTABLE_MESSAGE),
            };
          }
          if (existingAuth.exists) {
            return {
              outcome: "failed",
              message: WHATSAPP_LOGIN_AUTH_NOT_CLEARED_MESSAGE,
              error: err,
            };
          }
        }
        restartedStatuses.add(LOGGED_OUT_STATUS);
      } else {
        return {
          outcome: "failed",
          message: formatError(err),
          statusCode,
          error: err,
        };
      }

      const replacementFailure = await replaceLoginSocket();
      if (replacementFailure) {
        return replacementFailure;
      }
    }
  }
}

export class WhatsAppConnectionController {
  readonly accountId: string;
  readonly authDir: string;
  readonly socketRef: { current: WASocket | null };

  private readonly appSilenceTimeoutMs: number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly isNonRetryableStatus: (statusCode: unknown) => boolean;
  private readonly socketTiming: Required<WhatsAppSocketTimingOptions>;
  private readonly abortPromise?: Promise<"aborted">;
  private readonly disconnectRetryController = new AbortController();

  private current: WhatsAppLiveConnection | null = null;
  private runtimeContextLease: { dispose: () => void } | null = null;
  private pendingOwnerContextLease: { dispose: () => void } | null = null;
  private connectionOwnerLease: WhatsAppGatewayConnectionOwnerLease | null = null;
  private retainedOwnerReleaseLease: WhatsAppGatewayConnectionOwnerLease | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private connectionOwnerLeasePromise: Promise<void> | null = null;
  private connectionSetupPromise: Promise<WhatsAppLiveConnection> | null = null;
  private pendingSocketCleanup: WhatsAppSocketCleanup | null = null;
  private shuttingDown = false;
  private readonly ownerAcquireAbortController = new AbortController();
  private readonly setupAbortController = new AbortController();
  private reconnectAttempts = 0;
  private lastHandledInboundAt: number | null = null;

  constructor(
    private readonly params: {
      accountId: string;
      authDir: string;
      verbose: boolean;
      keepAlive: boolean;
      heartbeatSeconds: number;
      transportTimeoutMs: number;
      messageTimeoutMs: number;
      watchdogCheckMs: number;
      reconnectPolicy: ReconnectPolicy;
      abortSignal?: AbortSignal;
      sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
      isNonRetryableStatus?: (statusCode: unknown) => boolean;
      socketTiming?: WhatsAppSocketTimingOptions;
    },
  ) {
    this.params = { ...params };
    this.accountId = params.accountId;
    this.authDir = params.authDir;
    this.appSilenceTimeoutMs = params.messageTimeoutMs * 4;
    this.sleep = params.sleep ?? sleepWithAbort;
    this.isNonRetryableStatus = params.isNonRetryableStatus ?? (() => false);
    this.socketTiming = {
      ...DEFAULT_WHATSAPP_SOCKET_TIMING,
      ...params.socketTiming,
    };
    this.socketRef = { current: null };
    const abortSignal = params.abortSignal;
    if (abortSignal) {
      this.abortPromise = new Promise<"aborted">((resolve) => {
        const stop = () => {
          resolve("aborted");
          this.stopDisconnectRetries();
          this.ownerAcquireAbortController.abort(abortSignal.reason);
          this.setupAbortController.abort(abortSignal.reason);
        };
        if (abortSignal.aborted) {
          stop();
        } else {
          abortSignal.addEventListener("abort", stop, { once: true });
        }
      });
    }
  }

  getActiveListener(): ActiveWebListener | null {
    return this.current?.listener ?? null;
  }

  getCurrentSock(): WASocket | null {
    return this.socketRef.current;
  }

  getSelfIdentity(): WhatsAppSelfIdentity | null {
    const user = this.socketRef.current?.user;
    if (!user) {
      return null;
    }
    const jid = user.id ?? null;
    const lid = user.lid ?? null;
    if (!jid && !lid) {
      return null;
    }
    // Pre-resolve via the controller's authDir so e164 is populated from the
    // auth-state PN<->LID mapping. That lets `identitiesOverlap()` recognize a
    // successor logged into the same account even when the original socket
    // exposes only the PN form and the successor exposes only the LID form.
    const resolved = resolveComparableIdentity({ jid, lid }, this.authDir);
    return { jid: resolved.jid, lid: resolved.lid, e164: resolved.e164 };
  }

  getReconnectAttempts(): number {
    return this.reconnectAttempts;
  }

  isStopRequested(): boolean {
    return this.params.abortSignal?.aborted === true;
  }

  shouldRetryDisconnect(): boolean {
    return (
      this.params.keepAlive &&
      !this.isStopRequested() &&
      !this.disconnectRetryController.signal.aborted
    );
  }

  getDisconnectRetryAbortSignal(): AbortSignal {
    return this.disconnectRetryController.signal;
  }

  noteInbound(timestamp = Date.now()): void {
    if (!this.current) {
      return;
    }
    this.current.handledMessages += 1;
    this.current.lastInboundAt = timestamp;
    this.current.lastTransportActivityAt = timestamp;
    this.current.openedAfterRecentInbound = false;
    this.lastHandledInboundAt = timestamp;
  }

  noteTransportActivity(timestamp = Date.now()): void {
    if (!this.current) {
      return;
    }
    this.current.lastTransportActivityAt = timestamp;
  }

  getCurrentSnapshot(
    connection: WhatsAppLiveConnection | null = this.current,
  ): WhatsAppConnectionSnapshot | null {
    if (!connection) {
      return null;
    }
    return {
      connectionId: connection.connectionId,
      startedAt: connection.startedAt,
      lastInboundAt: connection.lastInboundAt,
      lastTransportActivityAt: connection.lastTransportActivityAt,
      handledMessages: connection.handledMessages,
      reconnectAttempts: this.reconnectAttempts,
      uptimeMs: Date.now() - connection.startedAt,
    };
  }

  setUnhandledRejectionCleanup(unregister: (() => void) | null): void {
    if (!this.current) {
      unregister?.();
      return;
    }
    this.current.unregisterUnhandled?.();
    this.current.unregisterUnhandled = unregister;
  }

  async openConnection(params: WhatsAppOpenConnectionParams): Promise<WhatsAppLiveConnection> {
    if (this.shuttingDown) {
      throw stoppedControllerError();
    }
    if (this.connectionSetupPromise) {
      throw new Error("WhatsApp connection setup is already in progress");
    }
    const setupPromise = this.openConnectionOwned(params);
    this.connectionSetupPromise = setupPromise;
    try {
      return await setupPromise;
    } finally {
      if (this.connectionSetupPromise === setupPromise) {
        this.connectionSetupPromise = null;
      }
    }
  }

  private async openConnectionOwned(
    params: WhatsAppOpenConnectionParams,
  ): Promise<WhatsAppLiveConnection> {
    await this.ensureConnectionOwnership();
    this.throwIfSetupStopped();
    await this.finishPendingSocketCleanup();
    this.throwIfSetupStopped();
    if (this.current) {
      await this.closeCurrentConnection();
    }
    this.throwIfSetupStopped();

    let sock: WaSocket | null = null;
    let connection: WhatsAppLiveConnection | null = null;
    try {
      sock = await createWaSocket(false, this.params.verbose, {
        authDir: this.authDir,
        ...this.socketTiming,
        ...(params.getMessage ? { getMessage: params.getMessage } : {}),
        ...(params.cachedGroupMetadata ? { cachedGroupMetadata: params.cachedGroupMetadata } : {}),
      });
      this.throwIfSetupStopped();
      await this.waitForSetupStep(
        waitForWaConnection(sock, { timeoutMs: this.socketTiming.connectTimeoutMs }),
      );
      this.throwIfSetupStopped();
      this.socketRef.current = sock;
      const placeholderListener = {} as ManagedWhatsAppListener;
      const openedAfterRecentInbound =
        this.reconnectAttempts > 0 &&
        this.lastHandledInboundAt !== null &&
        Date.now() - this.lastHandledInboundAt <= this.appSilenceTimeoutMs;
      const close = createDeferred<WebListenerCloseReason>();
      connection = {
        connectionId: params.connectionId,
        startedAt: Date.now(),
        sock,
        listener: placeholderListener,
        heartbeat: null,
        watchdogTimer: null,
        lastInboundAt: null,
        lastTransportActivityAt: Date.now(),
        handledMessages: 0,
        unregisterUnhandled: null,
        unregisterTransportActivity: null,
        openedAfterRecentInbound,
        backgroundTasks: new Set<Promise<unknown>>(),
        closePromise: close.promise,
        resolveClose: close.resolve,
        socketClosed: false,
      };
      const listenerTask = params.createListener({ sock, connection });
      let listener: ManagedWhatsAppListener;
      try {
        listener = await this.waitForSetupStep(listenerTask);
      } catch (error) {
        if (this.setupAbortController.signal.aborted) {
          void listenerTask.then((lateListener) => lateListener.close?.()).catch(() => {});
        }
        throw error;
      }
      connection.listener = listener;
      this.throwIfSetupStopped();
      this.current = connection;
      connection.unregisterTransportActivity = this.attachTransportActivityListener(sock);
      const previousRuntimeContextLease = this.runtimeContextLease;
      // Publish only after the listener is ready. Lease tokens make disposal of this
      // controller's previous registration unable to remove a newer replacement.
      this.runtimeContextLease = registerChannelRuntimeContext({
        channelRuntime: getWhatsAppChannelRuntime(),
        channelId: "whatsapp",
        accountId: this.accountId,
        capability: WHATSAPP_CONNECTION_CONTROLLER_CAPABILITY,
        context: this,
        abortSignal: this.params.abortSignal,
      });
      previousRuntimeContextLease?.dispose();
      this.pendingOwnerContextLease?.dispose();
      this.pendingOwnerContextLease = null;
      this.startTimers(connection, {
        onHeartbeat: params.onHeartbeat,
        onWatchdogTimeout: params.onWatchdogTimeout,
      });
      return connection;
    } catch (err) {
      try {
        if (connection && this.current === connection) {
          await this.closeCurrentConnection();
        } else {
          try {
            await connection?.listener.close?.();
          } catch {
            // Socket closure remains authoritative for ownership release.
          }
          if (this.socketRef.current === sock) {
            this.socketRef.current = null;
          }
          if (sock) {
            const cleanup = connection ?? { sock, socketClosed: false };
            await this.finishSocketCleanup(cleanup);
          }
          if (connection?.unregisterUnhandled) {
            connection.unregisterUnhandled();
          }
          connection?.unregisterTransportActivity?.();
        }
      } catch (closeError) {
        if (sock && (!connection || this.current !== connection)) {
          this.pendingSocketCleanup = connection ?? { sock, socketClosed: false };
        }
        const aggregateError = new AggregateError(
          [err, closeError],
          "WhatsApp connection setup and close failed",
          { cause: err },
        );
        throw aggregateError;
      }
      throw err;
    }
  }

  async waitForClose(): Promise<WebListenerCloseReason | "aborted"> {
    const connection = this.current;
    if (!connection) {
      return "aborted";
    }
    const listenerClose =
      connection.listener.onClose?.catch((err: unknown) => ({
        status: 500,
        isLoggedOut: false,
        error: err,
      })) ?? createNeverResolvePromise<WebListenerCloseReason>();

    return await Promise.race([
      connection.closePromise,
      listenerClose,
      this.abortPromise ?? createNeverResolvePromise<"aborted">(),
    ]);
  }

  normalizeCloseReason(reason: WebListenerCloseReason): NormalizedConnectionCloseReason {
    const statusCode = reason?.status ?? undefined;
    return {
      statusCode,
      statusLabel: typeof statusCode === "number" ? statusCode : "unknown",
      isLoggedOut: reason.isLoggedOut,
      error: reason?.error,
      errorText: formatError(reason),
    };
  }

  resolveCloseDecision(
    reason: WebListenerCloseReason | "aborted",
  ): WhatsAppConnectionCloseDecision | "aborted" {
    if (reason === "aborted" || this.isStopRequested()) {
      return "aborted";
    }

    const current = this.current;
    if (current && Date.now() - current.startedAt > this.params.heartbeatSeconds * 1000) {
      this.reconnectAttempts = 0;
    }

    const normalized = this.normalizeCloseReason(reason);
    if (normalized.isLoggedOut) {
      return {
        action: "stop",
        reconnectAttempts: this.reconnectAttempts,
        healthState: "logged-out",
        normalized,
      };
    }

    if (this.isNonRetryableStatus(normalized.statusCode)) {
      return {
        action: "stop",
        reconnectAttempts: this.reconnectAttempts,
        healthState: "conflict",
        normalized,
      };
    }

    return { ...this.consumeReconnectAttempt(), normalized };
  }

  resolveSetupErrorDecision(error: unknown): WhatsAppConnectionCloseDecision | "aborted" | null {
    const statusCode = getStatusCode(error);
    if (typeof statusCode !== "number") {
      return null;
    }

    return this.resolveCloseDecision({
      status: statusCode,
      isLoggedOut: statusCode === LOGGED_OUT_STATUS,
      error,
    });
  }

  consumeReconnectAttempt(): WhatsAppReconnectAttemptDecision {
    this.reconnectAttempts += 1;
    if (
      this.params.reconnectPolicy.maxAttempts > 0 &&
      this.reconnectAttempts >= this.params.reconnectPolicy.maxAttempts
    ) {
      return {
        action: "stop",
        reconnectAttempts: this.reconnectAttempts,
        healthState: "stopped",
      };
    }

    return {
      action: "retry",
      delayMs: computeBackoff(this.params.reconnectPolicy, this.reconnectAttempts),
      reconnectAttempts: this.reconnectAttempts,
      healthState: "reconnecting",
    };
  }

  forceClose(reason: WebListenerCloseReason): void {
    const connection = this.current;
    if (!connection) {
      return;
    }
    connection.resolveClose(reason);
    connection.listener.signalClose?.(reason);
  }

  async closeCurrentConnection(): Promise<void> {
    const connection = this.current;
    if (!connection) {
      return;
    }
    // Stop exposing the listener before any fallible teardown. The cleanup record
    // remains reachable so later reconnect/shutdown attempts can finish safely.
    this.current = null;
    this.pendingSocketCleanup = connection;
    if (this.socketRef.current === connection.sock) {
      this.socketRef.current = null;
    }
    connection.unregisterUnhandled?.();
    connection.unregisterTransportActivity?.();
    if (connection.heartbeat) {
      clearInterval(connection.heartbeat);
    }
    if (connection.watchdogTimer) {
      clearInterval(connection.watchdogTimer);
    }
    if (connection.backgroundTasks.size > 0) {
      await Promise.allSettled(connection.backgroundTasks);
      connection.backgroundTasks.clear();
    }
    try {
      await connection.listener.close?.();
    } catch {
      // best-effort close
    }
    await this.finishSocketCleanup(connection);
    if (this.pendingSocketCleanup === connection) {
      this.pendingSocketCleanup = null;
    }
  }

  async waitBeforeRetry(delayMs: number): Promise<void> {
    await this.sleep(delayMs, this.params.abortSignal);
  }

  /**
   * Single-flight: a replacement monitor may retry this cleanup through the owner
   * lease while the original shutdown is still running.
   */
  async shutdown(): Promise<void> {
    if (!this.shutdownPromise) {
      const attempt = this.runShutdown().finally(() => {
        if (this.shutdownPromise === attempt) {
          this.shutdownPromise = null;
        }
      });
      this.shutdownPromise = attempt;
    }
    await this.shutdownPromise;
  }

  private async runShutdown(): Promise<void> {
    this.shuttingDown = true;
    const stoppedError = stoppedControllerError();
    this.ownerAcquireAbortController.abort(stoppedError);
    this.setupAbortController.abort(stoppedError);
    this.stopDisconnectRetries();
    await this.connectionSetupPromise?.catch(() => {});
    await this.connectionOwnerLeasePromise?.catch(() => {});
    await this.closeCurrentConnection();
    await this.finishPendingSocketCleanup();
    try {
      this.runtimeContextLease?.dispose();
    } finally {
      this.runtimeContextLease = null;
      try {
        this.pendingOwnerContextLease?.dispose();
      } finally {
        this.pendingOwnerContextLease = null;
        // Contexts stay unpublished even when a retryable owner release fails.
        // Keeping that lease reference preserves fail-closed process ownership.
        if (this.connectionOwnerLease) {
          await this.connectionOwnerLease.release();
          this.connectionOwnerLease = null;
        }
        if (this.retainedOwnerReleaseLease) {
          await this.retainedOwnerReleaseLease.release();
          this.retainedOwnerReleaseLease = null;
        }
      }
    }
  }

  private async finishSocketCleanup(cleanup: WhatsAppSocketCleanup): Promise<void> {
    if (!cleanup.socketClosed) {
      await closeWhatsAppSocketAndWait(cleanup.sock, "OpenClaw WhatsApp socket close");
      cleanup.socketClosed = true;
    }
    const queueResult = await waitForCredsSaveQueueWithTimeout(this.authDir);
    if (queueResult === "timed_out") {
      throw new Error("WhatsApp credential persistence did not drain before owner release");
    }
  }

  private async finishPendingSocketCleanup(): Promise<void> {
    const cleanup = this.pendingSocketCleanup;
    if (!cleanup) {
      return;
    }
    await this.finishSocketCleanup(cleanup);
    if (this.pendingSocketCleanup === cleanup) {
      this.pendingSocketCleanup = null;
    }
  }

  private throwIfSetupStopped(): void {
    if (this.shuttingDown || this.setupAbortController.signal.aborted) {
      throw stoppedControllerError();
    }
  }

  private async waitForSetupStep<T>(task: Promise<T>): Promise<T> {
    this.throwIfSetupStopped();
    return await racePromiseWithAbortSignal(
      task,
      this.setupAbortController.signal,
      stoppedControllerError,
    );
  }

  private async ensureConnectionOwnership(): Promise<void> {
    if (this.retainedOwnerReleaseLease) {
      await this.retainedOwnerReleaseLease.release();
      this.retainedOwnerReleaseLease = null;
    }
    if (this.connectionOwnerLease) {
      return;
    }
    if (!this.connectionOwnerLeasePromise) {
      this.connectionOwnerLeasePromise = (async () => {
        const ownerLease = await acquireWhatsAppGatewayConnectionOwner(
          this.authDir,
          this.ownerAcquireAbortController.signal,
        );
        // A failed shutdown keeps this lease held after the monitor has exited, so a
        // later startup finishes the cleanup through the lease. Healthy owners ignore it.
        ownerLease.setCleanupRetry(async () => {
          if (this.shuttingDown) {
            await this.shutdown();
          }
        });
        try {
          if (this.shuttingDown) {
            throw stoppedControllerError();
          }
          // Keep a pending marker separate from the ready controller capability. This
          // blocks a second socket without replacing a still-working controller on reload.
          this.pendingOwnerContextLease = registerChannelRuntimeContext({
            channelRuntime: getWhatsAppChannelRuntime(),
            channelId: "whatsapp",
            accountId: this.accountId,
            capability: WHATSAPP_CONNECTION_OWNER_PENDING_CAPABILITY,
            context: true,
            abortSignal: this.params.abortSignal,
          });
          this.connectionOwnerLease = ownerLease;
        } catch (error) {
          try {
            await ownerLease.release();
          } catch (releaseError) {
            this.retainedOwnerReleaseLease = ownerLease;
            const aggregateError = new AggregateError(
              [error, releaseError],
              "WhatsApp connection ownership setup and release failed",
              { cause: error },
            );
            throw aggregateError;
          }
          throw error;
        }
      })().finally(() => {
        this.connectionOwnerLeasePromise = null;
      });
    }
    await this.connectionOwnerLeasePromise;
  }

  private startTimers(
    connection: WhatsAppLiveConnection,
    hooks: {
      onHeartbeat?: (snapshot: WhatsAppConnectionSnapshot) => void;
      onWatchdogTimeout?: (snapshot: WhatsAppConnectionSnapshot) => void;
    },
  ): void {
    if (!this.params.keepAlive) {
      return;
    }

    connection.heartbeat = setInterval(() => {
      const snapshot = this.getCurrentSnapshot(connection);
      if (!snapshot) {
        return;
      }
      hooks.onHeartbeat?.(snapshot);
    }, this.params.heartbeatSeconds * 1000);

    connection.watchdogTimer = setInterval(() => {
      const now = Date.now();
      const transportStaleForMs = now - connection.lastTransportActivityAt;
      const appBaselineAt = connection.lastInboundAt ?? connection.startedAt;
      const appSilentForMs = now - appBaselineAt;
      const appSilenceTimeoutMs = connection.openedAfterRecentInbound
        ? this.params.messageTimeoutMs
        : this.appSilenceTimeoutMs;
      if (
        transportStaleForMs <= this.params.transportTimeoutMs &&
        appSilentForMs <= appSilenceTimeoutMs
      ) {
        return;
      }
      const snapshot = this.getCurrentSnapshot(connection);
      if (!snapshot) {
        return;
      }
      hooks.onWatchdogTimeout?.(snapshot);
      this.forceClose({
        status: 499,
        isLoggedOut: false,
        error: WHATSAPP_WATCHDOG_TIMEOUT_ERROR,
      });
    }, this.params.watchdogCheckMs);
  }

  private attachTransportActivityListener(sock: WASocket): (() => void) | null {
    const ws = sock.ws as SocketActivityEmitter | undefined;
    if (!ws || typeof ws.on !== "function") {
      return null;
    }

    const noteActivity = () => this.noteTransportActivity();
    ws.on("frame", noteActivity);

    return () => {
      if (typeof ws.off === "function") {
        ws.off("frame", noteActivity);
        return;
      }
      ws.removeListener?.("frame", noteActivity);
    };
  }

  private stopDisconnectRetries(): void {
    if (!this.disconnectRetryController.signal.aborted) {
      this.disconnectRetryController.abort();
    }
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
