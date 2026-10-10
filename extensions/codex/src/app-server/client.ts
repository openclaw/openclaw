import { randomUUID } from "node:crypto";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { coerceErrorMessage, toStringifiedError } from "openclaw/plugin-sdk/error-runtime";
import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import type { CodexCatalogPreviewCache } from "../session-catalog-native-projection.js";
import {
  closeCodexCatalogClientSource,
  codexCatalogSourceForClient,
} from "../session-catalog-source.js";
import type { CodexClientRequestAttempt } from "./client-catalog-response.js";
import { CodexCatalogWorker, codexCatalogRequestId } from "./client-catalog-worker.js";
import {
  appendBoundedTail,
  buildCodexAppServerExitError,
  logCodexAppServerParseFailure,
  observeCodexAppServerStderr,
} from "./client-diagnostics.js";
import {
  buildCodexAppServerInitializeParams,
  assertSupportedCodexAppServerVersion,
  buildCodexAppServerRuntimeIdentity,
  createCodexInitializeDiagnostics,
} from "./client-initialize.js";
import { redactCodexAppServerLinePreview } from "./client-line-preview.js";
import { CodexAppServerMessageDecoder } from "./client-message-decoder.js";
import {
  listenCodexAppServerLines,
  createCodexAppServerMessageWriter,
  readCodexCatalogDecodeRoute,
  type CodexCatalogDecodeRoute,
} from "./client-message-frames.js";
import {
  CodexAppServerNotifications,
  type CodexServerNotificationHandler,
} from "./client-notifications.js";
import { dispatchCodexAppServerResponse } from "./client-response.js";
import type { CodexAppServerStartOptions } from "./config-contracts.js";
import { resolveCodexAppServerRuntimeOptions } from "./config-runtime.js";
import {
  type CodexAppServerRequestMethod,
  type CodexAppServerRequestParams,
  type CodexAppServerRequestResult,
  isJsonObject,
  isRpcResponse,
  type CodexServerNotification,
  type JsonValue,
  type RpcMessage,
  type RpcRequest,
} from "./protocol.js";
import { dispatchCodexRequestAttempt } from "./request-admission.js";
import { createCodexRequestAttempt } from "./request-attempt.js";
import type { CodexRequestWaiterFinished } from "./request-observation.js";
import {
  isCodexAppServerOverloadError,
  CodexAppServerRpcError,
  CodexAppServerLocalRequestCancellationError,
} from "./rpc-error.js";
import { CodexServerRequests, type CodexServerRequestHandler } from "./server-requests.js";
import { getCodexAppServerRegisteredTransportIdentity } from "./transport-process-registration.js";
import { createStdioTransport } from "./transport-stdio.js";
import { createWebSocketTransport } from "./transport-websocket.js";
import {
  closeCodexAppServerTransport,
  closeCodexAppServerTransportAndWait,
  hasCodexAppServerNaturalExit,
  type CodexAppServerCloseResult,
  type CodexAppServerTransport,
} from "./transport.js";

const CODEX_APP_SERVER_STDERR_TAIL_MAX = 2_000;
const CODEX_APP_SERVER_OVERLOAD_MAX_RETRIES = 3;
const CODEX_APP_SERVER_OVERLOAD_RETRY_BASE_MS = 50;

function remainingRequestTime(
  method: string,
  signal: AbortSignal | undefined,
  deadline?: number,
): number | undefined {
  if (signal?.aborted) {
    throw new CodexAppServerLocalRequestCancellationError(method, "aborted", false, signal.reason);
  }
  const remainingMs = deadline === undefined ? undefined : deadline - performance.now();
  if (remainingMs !== undefined && remainingMs <= 0) {
    throw new CodexAppServerLocalRequestCancellationError(method, "timed out", false);
  }
  return remainingMs;
}

export {
  getCodexAppServerClientInstanceId,
  resolveCodexAppServerClientInstanceId,
} from "./client-diagnostics.js";

type RequestOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  assertCurrent?: () => void;
  /** Prepare authority asynchronously, retaining it only through synchronous wire admission. */
  withCurrent?: (write: () => void) => Promise<void>;
  catalogPreview?: true;
  catalogPreviewCache?: CodexCatalogPreviewCache;
  catalogRows?: number;
  attemptWaiterFinished?: CodexRequestWaiterFinished;
  onIngressRejected?: () => void;
};

type ThreadSessionRequestGuard = (options: {
  signal?: AbortSignal;
  timeoutMs?: number;
  timeoutMessage: string;
  abortMessage: string;
}) => Promise<() => void>;

export { CodexAppServerRpcError } from "./rpc-error.js";

export { isCodexAppServerOverloadError } from "./rpc-error.js";

export function isCodexAppServerRequestTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "CODEX_APP_SERVER_LOCAL_REQUEST_CANCELLED" &&
    "reason" in error &&
    error.reason === "timed out"
  );
}

export { isCodexAppServerBrokenPipeError } from "./client-diagnostics.js";

class CodexAppServerIndeterminateTransportError extends Error {
  readonly code = "CODEX_APP_SERVER_REQUEST_TRANSPORT_INDETERMINATE";
  readonly mayHaveWritten = true;

  constructor(method: string, cause: Error) {
    super(`${method} transport failed after request write: ${cause.message}`, { cause });
    this.name = "CodexAppServerIndeterminateTransportError";
  }
}

/** True when a local cancellation can leave an app-server request in flight. */
export function isCodexAppServerIndeterminateRequestCancellationError(
  error: unknown,
): error is Error & { code: "CODEX_APP_SERVER_LOCAL_REQUEST_CANCELLED"; mayHaveWritten: true } {
  return hasRequestWriteState(error, "CODEX_APP_SERVER_LOCAL_REQUEST_CANCELLED", true);
}

/** True when local cancellation happened before a request write was attempted. */
export function isCodexAppServerPrewriteRequestCancellationError(
  error: unknown,
): error is Error & { code: "CODEX_APP_SERVER_LOCAL_REQUEST_CANCELLED"; mayHaveWritten: false } {
  return hasRequestWriteState(error, "CODEX_APP_SERVER_LOCAL_REQUEST_CANCELLED", false);
}

/** True when transport failure cannot prove a written request stopped running. */
export function isCodexAppServerIndeterminateTransportError(error: unknown): error is Error & {
  code: "CODEX_APP_SERVER_REQUEST_TRANSPORT_INDETERMINATE";
  mayHaveWritten: true;
} {
  return hasRequestWriteState(error, "CODEX_APP_SERVER_REQUEST_TRANSPORT_INDETERMINATE", true);
}

function hasRequestWriteState(error: unknown, code: string, written: boolean): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === code &&
    "mayHaveWritten" in error &&
    error.mayHaveWritten === written
  );
}

export function isCodexAppServerConnectionClosedError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (isCodexAppServerIndeterminateTransportError(error)) {
    return true;
  }
  return (
    error.message === "codex app-server client is closed" ||
    error.message.startsWith("codex app-server exited:")
  );
}

/** Runtime identity returned by the Codex app-server initialize handshake. */
export type CodexAppServerRuntimeIdentity = ReturnType<typeof buildCodexAppServerRuntimeIdentity>;
export { isUnsupportedCodexAppServerVersionError } from "./client-initialize.js";

export class CodexAppServerClient {
  private readonly instanceId = randomUUID();
  private readonly child: CodexAppServerTransport;
  private readonly closeMessageReader: () => void;
  private readonly decoder = new CodexAppServerMessageDecoder(logCodexAppServerParseFailure);
  private readonly catalogWorker = new CodexCatalogWorker();
  private catalogWorkerClosed: Promise<void> | undefined;
  private serverRequestsClosed: Promise<void> | undefined;
  private readonly pending = new Map<number | string, CodexClientRequestAttempt>();
  private readonly serverRequests = new CodexServerRequests((response) =>
    this.writeMessage(response),
  );
  private readonly notificationDispatch = new CodexAppServerNotifications();
  private readonly closeHandlers = new Set<(client: CodexAppServerClient) => void>();
  private nextId = 1;
  private initialized = false;
  private readonly initializeDiagnostics = createCodexInitializeDiagnostics();
  private initializeObservation: ReturnType<typeof this.initializeDiagnostics.begin> | undefined;
  private modelCatalogRevision = 0;
  private closed = false;
  private transportExited = false;
  private nativeExecutionObserved = false;
  private closeError: Error | undefined;
  private runtimeIdentity: CodexAppServerRuntimeIdentity | undefined;
  private threadSessionRequestGuard: ThreadSessionRequestGuard | undefined;
  private retireAfterIndeterminateThreadRequest: (() => boolean) | undefined;
  private stderrTail = "";
  private readonly privateTransportSecrets = new Set<string>();
  private privateStderrPending = "";

  private constructor(child: CodexAppServerTransport) {
    this.child = child;
    this.closeMessageReader = listenCodexAppServerLines(
      child.stdout,
      (line) => {
        const route =
          this.catalogWorker.continuation ??
          (this.decoder.hasPending ? undefined : readCodexCatalogDecodeRoute(line));
        if (route) {
          return this.decodeCatalogLine(line, route);
        }
        return this.handleParsedMessage(this.decoder.parse(line.toString("utf8")));
      },
      (error) => this.closeWithError(toStringifiedError(error)),
    );
    child.stdout.on("error", (error) => this.closeWithError(toStringifiedError(error)));
    observeCodexAppServerStderr(child.stderr, (chunk) => {
      const text = this.redactPrivateStderr(chunk);
      this.stderrTail = appendBoundedTail(this.stderrTail, text, CODEX_APP_SERVER_STDERR_TAIL_MAX);
      return text;
    });
    child.once("error", (error) => this.closeWithError(toStringifiedError(error)));
    child.once("exit", (code, signal) => {
      this.transportExited = true;
      this.closeWithError(
        child.startupFailure?.error ?? buildCodexAppServerExitError(code, signal, this.stderrTail),
      );
    });
    // Guard against unhandled EPIPE / write-after-close errors on the stdin
    // stream. When the child process terminates abruptly the pipe can break
    // before the "exit" event fires, so a pending writeMessage() produces an
    // asynchronous error on stdin that would otherwise crash the gateway.
    child.stdin.on?.("error", (error) => this.closeWithError(toStringifiedError(error)));
  }

  static async start(
    options?: Partial<CodexAppServerStartOptions>,
    assertCurrent?: () => void,
  ): Promise<CodexAppServerClient> {
    const defaults = resolveCodexAppServerRuntimeOptions().start;
    const startOptions = {
      ...defaults,
      ...options,
      headers: options?.headers ?? defaults.headers,
    };
    if (startOptions.transport === "stdio" && startOptions.commandSource === "managed") {
      throw new Error("Managed Codex app-server start options must be resolved before spawn.");
    }
    if (startOptions.transport === "websocket" || startOptions.transport === "unix") {
      return new CodexAppServerClient(createWebSocketTransport(startOptions));
    }
    // The spawn callback runs synchronously before registration; initialization
    // stays blocked until registration finishes, without losing startup errors.
    let client!: CodexAppServerClient;
    try {
      await createStdioTransport(startOptions, process.env, assertCurrent, (child) => {
        client = new CodexAppServerClient(child);
      });
      return client;
    } catch (error) {
      assertCurrent?.();
      if (client?.transportExited && hasCodexAppServerNaturalExit(client.child)) {
        throw (
          client.child.startupFailure?.error ??
          buildCodexAppServerExitError(
            client.child.exitCode,
            client.child.signalCode,
            client.stderrTail,
          )
        );
      }
      // Cleanup must not turn a live-child registration refusal into
      // a retryable exit. Keep the refusal and its bounded, redacted diagnostics.
      const stderr = client?.getStderrDiagnostic();
      throw stderr
        ? new Error(`${coerceErrorMessage(error)}; stderr=${JSON.stringify(stderr)}`, {
            cause: error,
          })
        : error;
    }
  }

  static fromTransportForTests(child: CodexAppServerTransport): CodexAppServerClient {
    return new CodexAppServerClient(child);
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    const observation = this.initializeDiagnostics.begin();
    this.initializeObservation = observation;
    let succeeded = false;
    try {
      // The handshake identifies the exact app-server process we will keep using,
      // which matters when callers override the binary or app-server args.
      const response = await this.request(
        "initialize",
        buildCodexAppServerInitializeParams(),
      ).catch(async (error: unknown) => {
        if (this.closed && this.child.startupFailure) {
          await closeCodexAppServerTransportAndWait(this.child, { drainStdio: true });
          throw this.child.startupFailure.error ?? error;
        }
        throw error;
      });
      this.child.startupFailure?.complete();
      observation.boundary("version-validation");
      const serverVersion = assertSupportedCodexAppServerVersion(response);
      this.runtimeIdentity = buildCodexAppServerRuntimeIdentity(response, serverVersion);
      observation.boundary("initialized-notification");
      this.notify("initialized");
      this.initialized = true;
      observation.boundary("ready");
      succeeded = true;
    } finally {
      observation.finish(succeeded);
    }
  }

  getInitializeDiagnostic(beforeClientClose = false) {
    return this.initializeDiagnostics.snapshot(this.closed, beforeClientClose);
  }

  getServerVersion(): string | undefined {
    return this.runtimeIdentity?.serverVersion;
  }

  getRuntimeIdentity(): CodexAppServerRuntimeIdentity | undefined {
    return this.runtimeIdentity ? { ...this.runtimeIdentity } : undefined;
  }

  /** Returns a bounded, redacted stderr diagnostic from the app-server process. */
  getStderrDiagnostic(): string | undefined {
    return redactCodexAppServerLinePreview(this.stderrTail) || undefined;
  }

  /** Returns the terminal transport error that closed this physical client. */
  getCloseError(): Error | undefined {
    return this.closeError;
  }

  /** Stable generation id for this exact physical client instance. */
  getInstanceId(): string {
    return this.instanceId;
  }

  /** Account/config observations become stale before a mutation can enter the wire. */
  getModelCatalogRevision(): number {
    return this.modelCatalogRevision;
  }

  /** Installs the spawn-owner guard and retirement for config-loading thread requests. */
  setThreadSessionRequestGuard(
    guard: ThreadSessionRequestGuard | undefined,
    retireAfterIndeterminateRequest?: () => boolean,
  ): void {
    this.threadSessionRequestGuard = guard;
    this.retireAfterIndeterminateThreadRequest = retireAfterIndeterminateRequest;
  }

  /** Returns the local transport PID for scoped child-process cleanup, when available. */
  getTransportPid(): number | undefined {
    return this.child.pid;
  }

  getRegisteredTransportIdentity() {
    return getCodexAppServerRegisteredTransportIdentity(this.child);
  }

  request<M extends CodexAppServerRequestMethod>(
    method: M,
    params: CodexAppServerRequestParams<M>,
    options?: RequestOptions,
  ): Promise<CodexAppServerRequestResult<M>>;
  request<T = JsonValue | undefined>(
    method: string,
    params?: unknown,
    options?: RequestOptions,
  ): Promise<T>;
  request<T = JsonValue | undefined>(
    method: string,
    params?: unknown,
    optionsInput?: RequestOptions,
  ): Promise<T> {
    const options = optionsInput ?? {};
    if (this.closed) {
      return Promise.reject(this.closeError ?? new Error("codex app-server client is closed"));
    }
    if (options.signal?.aborted) {
      return Promise.reject(
        new CodexAppServerLocalRequestCancellationError(
          method,
          "aborted",
          false,
          options.signal?.reason,
        ),
      );
    }
    const guard =
      method === "thread/start" || method === "thread/resume" || method === "thread/fork"
        ? this.threadSessionRequestGuard
        : undefined;
    if (guard) {
      const retire = this.retireAfterIndeterminateThreadRequest;
      if (
        !options.signal &&
        !(
          options.timeoutMs !== undefined &&
          Number.isFinite(options.timeoutMs) &&
          options.timeoutMs > 0
        )
      ) {
        return Promise.reject(
          new TypeError(`${method} requires a positive finite timeout or abort signal`),
        );
      }
      return (async () => {
        const guardStartedAt = performance.now();
        const timeoutMessage = `${method} timed out`;
        const abortMessage = `${method} aborted`;
        let releaseGuard: () => void;
        try {
          releaseGuard = await guard({
            signal: options.signal,
            timeoutMs: options.timeoutMs,
            timeoutMessage,
            abortMessage,
          });
        } catch (error) {
          if (error instanceof Error && error.message === timeoutMessage) {
            throw new CodexAppServerLocalRequestCancellationError(method, "timed out", false);
          }
          if (error instanceof Error && error.message === abortMessage) {
            throw new CodexAppServerLocalRequestCancellationError(
              method,
              "aborted",
              false,
              options.signal?.reason,
            );
          }
          throw error;
        }
        let released = false;
        let removeExitHandler: (() => void) | undefined;
        const release = () => {
          if (released) {
            return;
          }
          released = true;
          removeExitHandler?.();
          releaseGuard();
        };
        let releaseWhenRequestSettles = true;
        let requestMayHaveWritten = false;
        let nativeResponded = false;
        try {
          const elapsedMs = performance.now() - guardStartedAt;
          const remainingTimeoutMs =
            options.timeoutMs === undefined ? undefined : options.timeoutMs - elapsedMs;
          if (remainingTimeoutMs !== undefined && remainingTimeoutMs <= 0) {
            throw new CodexAppServerLocalRequestCancellationError(method, "timed out", false);
          }
          return await this.requestWithOverloadRetry<T>(
            method,
            params,
            {
              ...options,
              ...(remainingTimeoutMs !== undefined ? { timeoutMs: remainingTimeoutMs } : {}),
            },
            (mayHaveWritten) => {
              requestMayHaveWritten = mayHaveWritten;
              nativeResponded = !mayHaveWritten;
            },
            () => {
              nativeResponded = true;
              if (!releaseWhenRequestSettles) {
                release();
              }
            },
          );
        } catch (error) {
          if (requestMayHaveWritten && !(error instanceof CodexAppServerRpcError)) {
            // A local deadline cannot prove Codex stopped loading native config.
            // Only the exact native response or physical exit can release the
            // fence. A late response must never resume the abandoned caller.
            releaseWhenRequestSettles = false;
            if (nativeResponded) {
              release();
            } else {
              removeExitHandler = this.addTransportExitHandler(release);
            }
            // New acquisitions need a fresh client; existing peers can finish,
            // including guarded helper startup after the native response arrives.
            if (!retire?.()) {
              await this.closeAndRunAfterExit(release, method);
            }
          }
          throw error;
        } finally {
          if (releaseWhenRequestSettles) {
            release();
          }
        }
      })();
    }
    return this.requestWithOverloadRetry<T>(method, params, options);
  }

  private async requestWithOverloadRetry<T>(
    method: string,
    params: unknown,
    options: RequestOptions,
    onWriteStateChange?: (mayHaveWritten: boolean) => void,
    onResponse?: () => void,
  ): Promise<T> {
    const deadline =
      options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs)
        ? performance.now() + options.timeoutMs
        : undefined;
    for (let retry = 0; ; retry += 1) {
      const remainingTimeoutMs = remainingRequestTime(method, options.signal, deadline);
      try {
        return await this.requestOnce<T>(
          method,
          params,
          {
            ...options,
            ...(remainingTimeoutMs !== undefined ? { timeoutMs: remainingTimeoutMs } : {}),
          },
          retry + 1,
          onWriteStateChange,
          deadline,
          onResponse,
        );
      } catch (error) {
        // Codex emits -32001 only when ingress rejects a request before enqueue,
        // so retrying mutating methods cannot duplicate server-side work.
        if (
          !isCodexAppServerOverloadError(error) ||
          retry >= CODEX_APP_SERVER_OVERLOAD_MAX_RETRIES
        ) {
          throw error;
        }
        // Ingress rejected this attempt, so cancellation before the retry
        // must not retire a shared client with no outstanding native request.
        onWriteStateChange?.(false);
        const backoffMs = Math.round(
          CODEX_APP_SERVER_OVERLOAD_RETRY_BASE_MS * 2 ** retry * (0.75 + Math.random() * 0.5),
        );
        await this.waitForOverloadRetry(method, backoffMs, deadline, options.signal);
      }
    }
  }

  private async waitForOverloadRetry(
    method: string,
    backoffMs: number,
    deadline: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const remainingMs = remainingRequestTime(method, signal, deadline);
    const delayMs = remainingMs === undefined ? backoffMs : Math.min(backoffMs, remainingMs);
    try {
      await sleepWithAbort(delayMs, signal, { ref: false });
    } catch (error) {
      remainingRequestTime(method, signal);
      throw error;
    }
  }

  private requestOnce<T>(
    method: string,
    params: unknown,
    options: RequestOptions,
    overloadAttemptOrdinal: number,
    onWriteStateChange?: (mayHaveWritten: boolean) => void,
    deadline?: number,
    onResponse?: () => void,
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(this.closeError ?? new Error("codex app-server client is closed"));
    }
    const id = codexCatalogRequestId(method, params, this.nextId++, options.catalogPreview);
    if (
      method === "account/login/start" ||
      method === "account/logout" ||
      method === "config/value/write" ||
      method === "config/batchWrite"
    ) {
      this.modelCatalogRevision += 1;
    }
    const message: RpcRequest = { id, method, params: params as JsonValue | undefined };
    const initialize =
      method === "initialize"
        ? this.initializeObservation?.attempt(overloadAttemptOrdinal)
        : undefined;
    const attempt: CodexClientRequestAttempt = createCodexRequestAttempt({
      method,
      retainWritten: onResponse !== undefined,
      observe: initialize?.observe,
      ...(method === "thread/list"
        ? { diagnosticIdentity: { clientInstanceId: this.instanceId, rpcId: id } }
        : {}),
      onResponse: onResponse
        ? (mayHaveWritten) => {
            onWriteStateChange?.(mayHaveWritten);
            onResponse();
          }
        : undefined,
      onIngressRejected: options.onIngressRejected,
      onSettled: () => {
        if (this.pending.get(id) === attempt) {
          this.pending.delete(id);
        }
      },
      cancellationError: (reason, written, cause) =>
        new CodexAppServerLocalRequestCancellationError(method, reason, written, cause),
      localError: (error, written) =>
        written &&
        !isCodexAppServerIndeterminateRequestCancellationError(error) &&
        !isCodexAppServerIndeterminateTransportError(error)
          ? new CodexAppServerIndeterminateTransportError(method, error)
          : error,
    });
    this.pending.set(id, attempt);
    if (options.catalogPreview) {
      attempt.catalogProjection = {
        preview: options.catalogPreviewCache,
        remainingRows: options.catalogRows,
      };
    }
    // Stateful ownership assertions remain pre-write checks.
    const result = attempt.wait<T>(
      {
        ...options,
        overloadAttemptOrdinal,
      },
      deadline,
    );
    dispatchCodexRequestAttempt(
      attempt,
      options,
      () => {
        if (this.closed) {
          throw this.closeError ?? new Error("codex app-server client is closed");
        }
        remainingRequestTime(method, options.signal, deadline);
      },
      () => {
        this.writeMessage(
          message,
          (error) => attempt.failLocal(error),
          () => {
            attempt.markWritten();
            onWriteStateChange?.(true);
          },
          initialize?.writeResult,
        );
      },
    );
    return result;
  }

  notify(method: string, params?: JsonValue): void {
    this.writeMessage({ method, params });
  }

  addRequestHandler(handler: CodexServerRequestHandler): () => void {
    this.serverRequests.handlers.add(handler);
    return () => this.serverRequests.handlers.delete(handler);
  }

  addNotificationHandler(handler: CodexServerNotificationHandler): () => void {
    return this.notificationDispatch.addHandler(handler);
  }

  addCloseHandler(handler: (client: CodexAppServerClient) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  /** Registers a handler for physical transport exit and returns its disposer. */
  addTransportExitHandler(handler: (client: CodexAppServerClient) => void): () => void {
    if (this.transportExited) {
      handler(this);
      return () => undefined;
    }
    const onExit = () => handler(this);
    this.child.once("exit", onExit);
    return () => this.child.off?.("exit", onExit);
  }

  close(): void {
    this.closeWithError(new Error("codex app-server client is closed"));
  }

  async closeAndWait(options?: {
    exitTimeoutMs?: number;
    forceKillDelayMs?: number;
  }): Promise<CodexAppServerCloseResult> {
    this.markClosed(new Error("codex app-server client is closed"));
    const [result] = await Promise.all([
      closeCodexAppServerTransportAndWait(this.child, options),
      this.waitForCloseWork(),
    ]);
    // Codex can discard terminal handles before OS cleanup. Later ancestry
    // containment cannot discharge a command whose descendants already reparented.
    return this.nativeExecutionObserved ? { ...result, cleanup: "uncertain" } : result;
  }

  /** Joins local settlement already started by close without changing transport policy. */
  async waitForCloseWork(): Promise<void> {
    // Refresh settlement must finish even if catalog cleanup has failed.
    await this.serverRequestsClosed;
    await this.catalogWorkerClosed;
  }

  /** Closes this transport and runs cleanup only after physical process exit. */
  async closeAndRunAfterExit(onExit: () => void, operation: string): Promise<void> {
    this.addTransportExitHandler(onExit);
    if (this.transportExited) {
      return;
    }
    try {
      await this.closeAndWait();
    } catch (closeError) {
      embeddedAgentLog.warn("codex app-server shutdown after indeterminate request failed", {
        closeError,
        operation,
      });
    }
  }

  private readonly writeMessage = createCodexAppServerMessageWriter({
    getTransport: () => this.child,
    isClosed: () => this.closed,
    onNativeExecution: () => {
      this.nativeExecutionObserved = true;
    },
  });

  /** Protect private loopback route capabilities before native diagnostics can mention them. */
  protectPrivateTransportSecret(secret: string): void {
    if (!/^[A-Za-z0-9_-]{43}$/.test(secret) || this.privateTransportSecrets.size >= 8) {
      if (!this.privateTransportSecrets.has(secret)) {
        throw new Error("Invalid private Codex transport capability");
      }
    }
    this.privateTransportSecrets.add(secret);
  }

  private redactPrivateStderr(chunk: string): string {
    let text = this.privateStderrPending + chunk;
    for (const secret of this.privateTransportSecrets) {
      text = text.replaceAll(secret, "[REDACTED]");
    }
    let held = 0;
    // A capability can span arbitrary pipe chunks. Retain only a possible token prefix.
    for (const secret of this.privateTransportSecrets) {
      for (let length = 1; length < secret.length; length++) {
        if (text.endsWith(secret.slice(0, length))) {
          held = Math.max(held, length);
        }
      }
    }
    this.privateStderrPending = held ? text.slice(-held) : "";
    return held ? text.slice(0, -held) : text;
  }

  private handleParsedMessage(parsed: unknown, previewStates?: (boolean | undefined)[]): void {
    if (this.closed || !parsed || typeof parsed !== "object") {
      return;
    }
    const message = parsed as RpcMessage;
    if (isRpcResponse(message)) {
      this.nativeExecutionObserved =
        dispatchCodexAppServerResponse(
          message,
          this.pending,
          codexCatalogSourceForClient(this),
          previewStates,
        ) || this.nativeExecutionObserved;
      return;
    }
    if (!("method" in message)) {
      return;
    }
    if ("id" in message && message.id !== undefined) {
      void this.serverRequests.handle({
        id: message.id,
        method: message.method,
        params: message.params,
      });
      return;
    }
    this.handleNotification({
      method: message.method,
      params: message.params,
    });
  }

  private async decodeCatalogLine(line: Buffer, route: CodexCatalogDecodeRoute): Promise<void> {
    const decoded = await this.catalogWorker.decode(line, route, this.pending);
    if (!decoded || this.closed) {
      return;
    }
    for (const failure of decoded.failures) {
      logCodexAppServerParseFailure(failure.value, failure.error, failure.fragmentCount);
    }
    if (decoded.projectionError) {
      this.pending.get(decoded.projectionError.id)?.reject(decoded.projectionError.error, false);
    } else if (decoded.message) {
      this.handleParsedMessage(decoded.message, decoded.previewStates);
    }
  }

  private handleNotification(notification: CodexServerNotification): void {
    const params = notification.params;
    if (notification.method === "serverRequest/resolved") {
      this.serverRequests.resolve(params);
    }
    if (
      notification.method === "item/commandExecution/outputDelta" ||
      notification.method === "item/commandExecution/terminalInteraction" ||
      (isJsonObject(params) &&
        ((isJsonObject(params.item) && params.item.type === "commandExecution") ||
          (isJsonObject(params.turn) &&
            Array.isArray(params.turn.items) &&
            params.turn.items.some(
              (item) => isJsonObject(item) && item.type === "commandExecution",
            ))))
    ) {
      this.nativeExecutionObserved = true;
    }
    if (notification.method === "account/updated") {
      this.modelCatalogRevision += 1;
    }
    this.notificationDispatch.dispatch(notification);
  }

  private closeWithError(error: Error): void {
    if (this.markClosed(error)) {
      closeCodexAppServerTransport(this.child, {
        drainStdio: !this.initialized && this.child.startupFailure !== undefined,
      });
    }
  }

  private markClosed(error: Error): boolean {
    if (this.closed) {
      return false;
    }
    this.initializeDiagnostics.closing();
    this.closed = true;
    closeCodexCatalogClientSource(this);
    this.closeError = error;
    this.closeMessageReader();
    this.decoder.clear();
    this.catalogWorkerClosed = this.catalogWorker.close(error);
    void this.catalogWorkerClosed?.catch((closeError: unknown) => {
      embeddedAgentLog.warn("codex catalog worker shutdown failed", { error: closeError });
    });
    this.serverRequestsClosed = this.serverRequests.close(error);
    for (const pending of this.pending.values()) {
      pending.close(error);
    }
    this.pending.clear();
    for (const handler of this.closeHandlers) {
      try {
        handler(this);
      } catch (closeError) {
        embeddedAgentLog.warn("codex app-server close handler failed", { error: closeError });
      }
    }
    return true;
  }
}

const CODEX_APP_SERVER_APPROVAL_REQUEST_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
]);

export function isCodexAppServerApprovalRequest(method: string): boolean {
  return CODEX_APP_SERVER_APPROVAL_REQUEST_METHODS.has(method);
}

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
