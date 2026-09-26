import { randomUUID } from "node:crypto";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { coerceErrorMessage, toStringifiedError } from "openclaw/plugin-sdk/error-runtime";
import { parse as parseSemver } from "semver";
import type { CodexCatalogPreviewCache } from "../session-catalog-native-projection.js";
import {
  closeCodexCatalogClientSource,
  codexCatalogSourceForClient,
} from "../session-catalog-source.js";
import { CodexCatalogWorker, codexCatalogRequestId } from "./client-catalog-worker.js";
import {
  appendBoundedTail,
  buildCodexAppServerExitError,
  logCodexAppServerParseFailure,
  observeCodexAppServerStderr,
} from "./client-diagnostics.js";
import {
  buildCodexAppServerInitializeParams,
  buildCodexAppServerRuntimeIdentity,
} from "./client-initialize.js";
import { redactCodexAppServerLinePreview } from "./client-line-preview.js";
import { CodexAppServerMessageDecoder } from "./client-message-decoder.js";
import {
  listenCodexAppServerLines,
  stringifyCodexAppServerMessage,
  readCodexCatalogDecodeRoute,
  type CodexCatalogDecodeRoute,
} from "./client-message-frames.js";
import { dispatchCodexAppServerResponse } from "./client-response.js";
import type { CodexAppServerStartOptions } from "./config-contracts.js";
import { resolveCodexAppServerRuntimeOptions } from "./config-runtime.js";
import {
  type CodexAppServerRequestMethod,
  type CodexAppServerRequestParams,
  type CodexAppServerRequestResult,
  type CodexInitializeResponse,
  isJsonObject,
  isRpcResponse,
  type CodexServerNotification,
  type JsonValue,
  type RpcMessage,
  type RpcRequest,
  type RpcResponse,
} from "./protocol.js";
import { createCodexRequestAttempt, type CodexRequestAttempt } from "./request-attempt.js";
import type { CodexRequestWaiterFinished } from "./request-observation.js";
import { CODEX_APP_SERVER_OVERLOADED_ERROR_CODE, CodexAppServerRpcError } from "./rpc-error.js";
import { CodexServerRequests, type CodexServerRequestHandler } from "./server-requests.js";
import { createStdioTransport } from "./transport-stdio.js";
import { createWebSocketTransport } from "./transport-websocket.js";
import {
  closeCodexAppServerTransport,
  closeCodexAppServerTransportAndWait,
  hasCodexAppServerNaturalExit,
  type CodexAppServerCloseResult,
  type CodexAppServerTransport,
} from "./transport.js";
import { CODEX_APP_SERVER_VERSION, MIN_SUPPORTED_CODEX_APP_SERVER_VERSION } from "./version.js";

const CODEX_APP_SERVER_STDERR_TAIL_MAX = 2_000;
const CODEX_APP_SERVER_OVERLOAD_MAX_RETRIES = 3;
const CODEX_APP_SERVER_OVERLOAD_RETRY_BASE_MS = 50;
const CODEX_APP_SERVER_PENDING_STARTUP_WARNINGS_MAX = 32;
const CODEX_APP_SERVER_CLIENT_INSTANCE_IDS = new WeakMap<object, string>();

type RequestOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  assertCurrent?: () => void;
  catalogPreview?: true;
  catalogPreviewCache?: CodexCatalogPreviewCache;
  catalogRows?: number;
  attemptWaiterFinished?: CodexRequestWaiterFinished;
};

/** Process-local generation fence for bindings tied to one app-server client instance. */
export function getCodexAppServerClientInstanceId(client: object): string {
  const current = CODEX_APP_SERVER_CLIENT_INSTANCE_IDS.get(client);
  if (current) {
    return current;
  }
  const created = randomUUID();
  CODEX_APP_SERVER_CLIENT_INSTANCE_IDS.set(client, created);
  return created;
}

export function resolveCodexAppServerClientInstanceId(client: object): string {
  const getInstanceId = (client as { getInstanceId?: () => string }).getInstanceId;
  return getInstanceId?.call(client) ?? getCodexAppServerClientInstanceId(client);
}

export { CodexAppServerRpcError } from "./rpc-error.js";

/** Codex rejects this exact code before enqueueing, including mutating requests. */
export function isCodexAppServerOverloadError(error: unknown): error is CodexAppServerRpcError {
  return (
    error instanceof CodexAppServerRpcError && error.code === CODEX_APP_SERVER_OVERLOADED_ERROR_CODE
  );
}

class CodexAppServerLocalRequestCancellationError extends Error {
  readonly code = "CODEX_APP_SERVER_LOCAL_REQUEST_CANCELLED";

  constructor(
    method: string,
    readonly reason: "aborted" | "timed out",
    readonly mayHaveWritten: boolean,
    cause?: unknown,
  ) {
    const detail =
      cause instanceof Error || typeof cause === "string" ? coerceErrorMessage(cause) : undefined;
    super(`${method} ${reason}${detail ? `: ${detail}` : ""}`, { cause });
    this.name = "CodexAppServerLocalRequestCancellationError";
  }
}

export function isCodexAppServerRequestTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "CODEX_APP_SERVER_LOCAL_REQUEST_CANCELLED" &&
    "reason" in error &&
    error.reason === "timed out"
  );
}

export function isCodexAppServerBrokenPipeError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if ("code" in current && current.code === "EPIPE") {
      return true;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

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
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "CODEX_APP_SERVER_LOCAL_REQUEST_CANCELLED" &&
    "mayHaveWritten" in error &&
    error.mayHaveWritten === true
  );
}

/** True when local cancellation happened before a request write was attempted. */
export function isCodexAppServerPrewriteRequestCancellationError(
  error: unknown,
): error is Error & { code: "CODEX_APP_SERVER_LOCAL_REQUEST_CANCELLED"; mayHaveWritten: false } {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "CODEX_APP_SERVER_LOCAL_REQUEST_CANCELLED" &&
    "mayHaveWritten" in error &&
    error.mayHaveWritten === false
  );
}

/** True when transport failure cannot prove a written request stopped running. */
export function isCodexAppServerIndeterminateTransportError(error: unknown): error is Error & {
  code: "CODEX_APP_SERVER_REQUEST_TRANSPORT_INDETERMINATE";
  mayHaveWritten: true;
} {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "CODEX_APP_SERVER_REQUEST_TRANSPORT_INDETERMINATE" &&
    "mayHaveWritten" in error &&
    error.mayHaveWritten === true
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

type CodexServerNotificationHandler = (
  notification: CodexServerNotification,
) => Promise<void> | void;

/** Runtime identity returned by the Codex app-server initialize handshake. */
export type CodexAppServerRuntimeIdentity = {
  serverVersion: string;
  userAgent?: string;
  codexHome?: string;
  platformFamily?: string;
  platformOs?: string;
};

export class CodexAppServerClient {
  private readonly instanceId = randomUUID();
  private readonly child: CodexAppServerTransport;
  private readonly closeMessageReader: () => void;
  private readonly decoder = new CodexAppServerMessageDecoder(logCodexAppServerParseFailure);
  private readonly catalogWorker = new CodexCatalogWorker();
  private catalogWorkerClosed: Promise<void> | undefined;
  private serverRequestsClosed: Promise<void> | undefined;
  private readonly pending = new Map<number | string, CodexRequestAttempt>();
  private readonly catalogResponses = new WeakMap<
    CodexRequestAttempt,
    { preview?: CodexCatalogPreviewCache; remainingRows?: number }
  >();
  private readonly serverRequests = new CodexServerRequests((response) =>
    this.writeMessage(response),
  );
  private readonly notificationHandlers = new Set<CodexServerNotificationHandler>();
  private readonly pendingStartupWarnings: CodexServerNotification[] = [];
  private readonly closeHandlers = new Set<(client: CodexAppServerClient) => void>();
  private nextId = 1;
  private initialized = false;
  private modelCatalogRevision = 0;
  private closed = false;
  private transportExited = false;
  private nativeExecutionObserved = false;
  private closeError: Error | undefined;
  private serverVersion: string | undefined;
  private runtimeIdentity: CodexAppServerRuntimeIdentity | undefined;
  private threadSessionRequestGuard:
    | ((options: {
        signal?: AbortSignal;
        timeoutMs?: number;
        timeoutMessage: string;
        abortMessage: string;
      }) => Promise<() => void>)
    | undefined;
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
    // The handshake identifies the exact app-server process we will keep using,
    // which matters when callers override the binary or app-server args.
    const response = await this.request("initialize", buildCodexAppServerInitializeParams());
    this.child.startupFailure?.complete();
    this.serverVersion = assertSupportedCodexAppServerVersion(response);
    this.runtimeIdentity = buildCodexAppServerRuntimeIdentity(response, this.serverVersion);
    this.notify("initialized");
    this.initialized = true;
  }

  getServerVersion(): string | undefined {
    return this.serverVersion;
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
    guard:
      | ((options: {
          signal?: AbortSignal;
          timeoutMs?: number;
          timeoutMessage: string;
          abortMessage: string;
        }) => Promise<() => void>)
      | undefined,
    retireAfterIndeterminateRequest?: () => boolean,
  ): void {
    this.threadSessionRequestGuard = guard;
    this.retireAfterIndeterminateThreadRequest = retireAfterIndeterminateRequest;
  }

  /** Returns the local transport PID for scoped child-process cleanup, when available. */
  getTransportPid(): number | undefined {
    return this.child.pid;
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
      if (options.signal?.aborted) {
        throw new CodexAppServerLocalRequestCancellationError(
          method,
          "aborted",
          false,
          options.signal?.reason,
        );
      }
      const remainingTimeoutMs = deadline === undefined ? undefined : deadline - performance.now();
      if (remainingTimeoutMs !== undefined && remainingTimeoutMs <= 0) {
        throw new CodexAppServerLocalRequestCancellationError(method, "timed out", false);
      }
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
    if (signal?.aborted) {
      throw new CodexAppServerLocalRequestCancellationError(
        method,
        "aborted",
        false,
        signal?.reason,
      );
    }
    const remainingMs = deadline === undefined ? undefined : deadline - performance.now();
    if (remainingMs !== undefined && remainingMs <= 0) {
      throw new CodexAppServerLocalRequestCancellationError(method, "timed out", false);
    }
    const delayMs = remainingMs === undefined ? backoffMs : Math.min(backoffMs, remainingMs);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, delayMs);
      timer.unref?.();
      const abortListener = () => {
        cleanup();
        reject(
          new CodexAppServerLocalRequestCancellationError(method, "aborted", false, signal?.reason),
        );
      };
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abortListener);
      };
      signal?.addEventListener("abort", abortListener, { once: true });
      if (signal?.aborted) {
        abortListener();
      }
    });
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
    const attempt = createCodexRequestAttempt({
      method,
      retainWritten: onResponse !== undefined,
      ...(method === "thread/list"
        ? { diagnosticIdentity: { clientInstanceId: this.instanceId, rpcId: id } }
        : {}),
      onResponse: onResponse
        ? (mayHaveWritten) => {
            onWriteStateChange?.(mayHaveWritten);
            onResponse();
          }
        : undefined,
      onSettled: () => {
        if (this.pending.get(id) === attempt) {
          this.pending.delete(id);
        }
      },
      cancellationError: (reason, written, cause) =>
        new CodexAppServerLocalRequestCancellationError(method, reason, written, cause),
      localError: (error, written) =>
        written &&
        !(error instanceof CodexAppServerRpcError) &&
        !isCodexAppServerIndeterminateRequestCancellationError(error) &&
        !isCodexAppServerIndeterminateTransportError(error)
          ? new CodexAppServerIndeterminateTransportError(method, error)
          : error,
    });
    this.pending.set(id, attempt);
    if (options.catalogPreview) {
      this.catalogResponses.set(attempt, {
        preview: options.catalogPreviewCache,
        remainingRows: options.catalogRows,
      });
    }
    // Stateful ownership assertions remain pre-write checks.
    const result = attempt.wait<T>(
      {
        ...options,
        assertCurrent: undefined,
        disposition: "new",
        overloadAttemptOrdinal,
      },
      deadline,
    );
    if (!attempt.pending) {
      return result;
    }
    try {
      options.assertCurrent?.();
      if (attempt.pending) {
        this.writeMessage(
          message,
          (error) => attempt.failLocal(error),
          () => {
            attempt.markWritten();
            onWriteStateChange?.(true);
          },
        );
      }
    } catch (error) {
      attempt.failLocal(toStringifiedError(error));
    }
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
    this.notificationHandlers.add(handler);
    // Codex sends configuration warnings immediately after initialize, before
    // OpenClaw can reserve the first thread or install its shared turn router.
    for (const notification of this.pendingStartupWarnings.splice(0)) {
      this.handleNotification(notification);
    }
    return () => this.notificationHandlers.delete(handler);
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
    if (!this.markClosed(new Error("codex app-server client is closed"))) {
      return;
    }
    closeCodexAppServerTransport(this.child);
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
    let settled = false;
    const runOnExit = () => {
      if (settled) {
        return;
      }
      settled = true;
      onExit();
    };
    if (this.transportExited) {
      runOnExit();
      return;
    }
    this.child.once("exit", runOnExit);
    try {
      await this.closeAndWait();
    } catch (closeError) {
      embeddedAgentLog.warn("codex app-server shutdown after indeterminate request failed", {
        closeError,
        operation,
      });
    }
  }

  private writeMessage(
    message: RpcRequest | RpcResponse,
    onError?: (error: Error) => void,
    beforeWrite?: () => void,
  ): void {
    if (this.closed) {
      return;
    }
    const id = "id" in message ? message.id : undefined;
    const method = "method" in message ? message.method : undefined;
    const frame = stringifyCodexAppServerMessage(message);
    // Reject locally before declaring a possible write. Images count toward the
    // transport frame limit even though Codex's text-input limit excludes them.
    if (this.child.maxFrameBytes && Buffer.byteLength(frame) > this.child.maxFrameBytes) {
      throw new Error(
        "Codex request exceeds the transport frame limit; reduce attached images or context.",
      );
    }
    beforeWrite?.();
    if (method === "command/exec") {
      this.nativeExecutionObserved = true;
    }
    this.child.stdin.write(`${frame}\n`, (error?: Error | null) => {
      if (error) {
        embeddedAgentLog.warn("codex app-server write failed", { error, id, method });
        onError?.(error);
      }
    });
  }

  /** Protect private loopback route capabilities before native diagnostics can mention them. */
  protectPrivateTransportSecret(secret: string): void {
    if (!/^[A-Za-z0-9_-]{43}$/.test(secret) || this.privateTransportSecrets.size >= 8) {
      if (!this.privateTransportSecrets.has(secret)) {
        throw new Error("Invalid private Codex transport capability");
      }
    }
    this.privateTransportSecrets.add(secret);
  }

  private redactPrivateText(text: string): string {
    let redacted = text;
    for (const secret of this.privateTransportSecrets) {
      redacted = redacted.replaceAll(secret, "[REDACTED]");
    }
    return redacted;
  }

  private redactPrivateStderr(chunk: string): string {
    const text = this.redactPrivateText(this.privateStderrPending + chunk);
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
      this.handleResponse(message, previewStates);
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
    const decoded = await this.catalogWorker.decode(
      line,
      route,
      this.pending,
      this.catalogResponses,
    );
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

  private handleResponse(response: RpcResponse, previewStates?: (boolean | undefined)[]): void {
    this.nativeExecutionObserved =
      dispatchCodexAppServerResponse(
        response,
        this.pending,
        this.catalogResponses,
        codexCatalogSourceForClient(this),
        previewStates,
      ) || this.nativeExecutionObserved;
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
    if (this.notificationHandlers.size === 0 && notification.method === "configWarning") {
      if (this.pendingStartupWarnings.length === CODEX_APP_SERVER_PENDING_STARTUP_WARNINGS_MAX) {
        this.pendingStartupWarnings.shift();
      }
      this.pendingStartupWarnings.push(notification);
      return;
    }
    for (const handler of this.notificationHandlers) {
      try {
        Promise.resolve(handler(notification)).catch((error: unknown) => {
          embeddedAgentLog.warn("codex app-server notification handler failed", { error });
        });
      } catch (error) {
        embeddedAgentLog.warn("codex app-server notification handler failed", { error });
      }
    }
  }

  private closeWithError(error: Error): void {
    if (this.markClosed(error)) {
      closeCodexAppServerTransport(this.child);
    }
  }

  private markClosed(error: Error): boolean {
    if (this.closed) {
      return false;
    }
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
    this.rejectPendingRequests(error);
    return true;
  }

  private rejectPendingRequests(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.cleanup();
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
  }
}

class CodexAppServerVersionError extends Error {
  readonly detectedVersion?: string;

  constructor(detectedVersion: string | undefined) {
    const detected = detectedVersion
      ? `detected ${detectedVersion}`
      : "OpenClaw could not determine the running Codex version";
    super(
      `Codex app-server ${MIN_SUPPORTED_CODEX_APP_SERVER_VERSION} or newer is required, but ${detected}. Update the configured Codex app-server binary, or remove custom command overrides to use the managed binary.`,
    );
    this.name = "CodexAppServerVersionError";
    this.detectedVersion = detectedVersion;
  }
}

function assertSupportedCodexAppServerVersion(response: CodexInitializeResponse): string {
  const detectedVersion = readCodexVersionFromUserAgent(response.userAgent);
  if (!detectedVersion) {
    throw new CodexAppServerVersionError(detectedVersion);
  }
  const detected = parseSemver(detectedVersion);
  if (!detected || detected.compare(MIN_SUPPORTED_CODEX_APP_SERVER_VERSION) < 0) {
    throw new CodexAppServerVersionError(detectedVersion);
  }
  if (detected.compare(CODEX_APP_SERVER_VERSION) > 0) {
    embeddedAgentLog.warn(
      "codex app-server is newer than OpenClaw's managed runtime; continuing with normal startup validation",
      {
        detectedVersion,
        validatedVersion: CODEX_APP_SERVER_VERSION,
      },
    );
  }
  return detectedVersion;
}

export function isUnsupportedCodexAppServerVersionError(error: unknown): boolean {
  return error instanceof CodexAppServerVersionError;
}

function readCodexVersionFromUserAgent(userAgent: string | undefined): string | undefined {
  // Codex returns `<originator>/<codex-version> ...`; the originator can be
  // OpenClaw, Codex Desktop, or an env override, so only the slash-delimited
  // version in the leading product field is stable.
  const match = userAgent?.match(
    /^[^/]+\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?:[\s(]|$)/,
  );
  return match?.[1];
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
