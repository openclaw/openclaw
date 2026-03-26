import {
  JsonRpcProtocolError,
  JsonRpcRemoteError,
  TimeoutError,
  TransportClosedError,
} from "./errors.js";
import type {
  GetAuthStatusParams,
  GetAuthStatusResponse,
  InitializeParams,
  InitializeResponse,
  ServerNotification,
  ServerRequest,
} from "./generated/protocol/index.js";
import type {
  AppsListParams,
  AppsListResponse,
  ChatgptAuthTokensRefreshParams,
  ChatgptAuthTokensRefreshResponse,
  ConfigBatchWriteParams,
  ConfigReadParams,
  ConfigReadResponse,
  ConfigValueWriteParams,
  ConfigWriteResponse,
  GetAccountParams,
  GetAccountResponse,
  ListMcpServerStatusParams,
  ListMcpServerStatusResponse,
  LoginAccountParams,
  LoginAccountResponse,
  ModelListParams,
  ModelListResponse,
  ThreadArchiveParams,
  ThreadArchiveResponse,
  ThreadForkParams,
  ThreadForkResponse,
  ThreadListParams,
  ThreadListResponse,
  ThreadReadParams,
  ThreadReadResponse,
  ThreadResumeParams,
  ThreadResumeResponse,
  ThreadStartParams,
  ThreadStartResponse,
  TurnCompletedNotification,
  TurnInterruptParams,
  TurnInterruptResponse,
  TurnStartParams,
  TurnStartResponse,
  TurnSteerParams,
  TurnSteerResponse,
} from "./generated/protocol/v2/index.js";
import {
  isJsonRpcErrorEnvelope,
  isJsonRpcNotificationEnvelope,
  isJsonRpcRequestEnvelope,
  isJsonRpcSuccessEnvelope,
  toJsonRpcErrorObject,
  type JsonRpcErrorObject,
  type JsonRpcMessage,
  type JsonRpcTraceContext,
} from "./jsonrpc.js";
import type {
  ClientMethod,
  ClientNotificationMethod,
  ClientRequestPayload,
  RequestId,
  ServerRequestMethod,
} from "./protocol.js";
import { ListenerSet, type Unsubscribe } from "./subscriptions.js";
import {
  CodexAppServerProcessTransport,
  type AppServerTransport,
  type SpawnCodexAppServerTransportOptions,
  type TransportCloseEvent,
} from "./transport/process.js";

const DEFAULT_CLIENT_INFO = {
  name: "codex-sdk",
  version: "0.1.0",
} as const;

export type UnhandledServerRequestStrategy = "reject" | "manual";

export interface RequestOptions {
  trace?: JsonRpcTraceContext | null;
}

export interface WaitForTurnCompletionOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface CodexAppServerClientOptions {
  transport: AppServerTransport;
  requestIdFactory?: () => RequestId;
  unhandledServerRequestStrategy?: UnhandledServerRequestStrategy;
}

export interface SpawnCodexAppServerClientOptions
  extends SpawnCodexAppServerTransportOptions, Omit<CodexAppServerClientOptions, "transport"> {}

export interface ServerRequestContext<M extends ServerRequestMethod = ServerRequestMethod> {
  request: Extract<ServerRequest, { method: M }>;
  respond(result: unknown): Promise<void>;
  respondError(error: JsonRpcErrorObject | Error | string): Promise<void>;
}

export type ServerRequestListener<M extends ServerRequestMethod = ServerRequestMethod> = (
  context: ServerRequestContext<M>,
) => void;

export type ServerRequestHandler<M extends ServerRequestMethod = ServerRequestMethod> = (
  context: ServerRequestContext<M>,
) => Promise<unknown> | unknown;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

interface TurnWaiter {
  resolve: (notification: TurnCompletedNotification) => void;
  reject: (error: unknown) => void;
  timeoutId?: NodeJS.Timeout;
  onAbort?: () => void;
  signal?: AbortSignal;
}

export class CodexAppServerClient {
  private readonly transport: AppServerTransport;
  private readonly requestIdFactory: () => RequestId;
  private readonly unhandledServerRequestStrategy: UnhandledServerRequestStrategy;
  private readonly pendingRequests = new Map<RequestId, PendingRequest>();
  private readonly pendingServerRequests = new Map<RequestId, ServerRequest>();
  private readonly notificationListeners = new ListenerSet<[ServerNotification]>();
  private readonly methodNotificationListeners = new Map<
    string,
    ListenerSet<[ServerNotification]>
  >();
  private readonly serverRequestListeners = new ListenerSet<[ServerRequestContext]>();
  private readonly methodServerRequestListeners = new Map<
    string,
    ListenerSet<[ServerRequestContext]>
  >();
  private readonly serverRequestHandlers = new Map<string, ServerRequestHandler<any>>();
  private readonly stderrListeners = new ListenerSet<[string]>();
  private readonly closeListeners = new ListenerSet<[TransportCloseEvent]>();
  private readonly completedTurns = new Map<string, TurnCompletedNotification>();
  private readonly turnWaiters = new Map<string, Set<TurnWaiter>>();
  private closed = false;
  private nextNumericRequestId = 1;

  constructor(options: CodexAppServerClientOptions) {
    this.transport = options.transport;
    this.requestIdFactory = options.requestIdFactory ?? (() => this.nextNumericRequestId++);
    this.unhandledServerRequestStrategy = options.unhandledServerRequestStrategy ?? "reject";

    this.transport.onMessage((message) => {
      void this.handleMessage(message);
    });
    this.transport.onError((error) => {
      this.rejectAllPending(error);
    });
    this.transport.onStderr((chunk) => {
      this.stderrListeners.emit(chunk);
    });
    this.transport.onClose((event) => {
      this.closed = true;
      this.rejectAllPending(new TransportClosedError(), event);
      this.closeListeners.emit(event);
    });
  }

  static async spawn(
    options: SpawnCodexAppServerClientOptions = {},
  ): Promise<CodexAppServerClient> {
    const transport = await CodexAppServerProcessTransport.spawn(options);
    return new CodexAppServerClient({
      transport,
      requestIdFactory: options.requestIdFactory,
      unhandledServerRequestStrategy: options.unhandledServerRequestStrategy,
    });
  }

  request<M extends ClientMethod, R = unknown>(
    method: M,
    params: ClientRequestPayload<M>,
    options?: RequestOptions,
  ): Promise<R>;
  request<R = unknown>(method: string, params?: unknown, options?: RequestOptions): Promise<R>;
  request<R = unknown>(method: string, params?: unknown, options: RequestOptions = {}): Promise<R> {
    if (this.closed) {
      return Promise.reject(new TransportClosedError());
    }

    const id = this.requestIdFactory();

    return new Promise<R>((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });

      try {
        this.transport.write({
          id,
          method,
          params,
          trace: options.trace,
        });
      } catch (error) {
        this.pendingRequests.delete(id);
        reject(error);
      }
    });
  }

  notify<M extends ClientNotificationMethod>(method: M, params?: never): void;
  notify(method: string, params?: unknown): void;
  notify(method: string, params?: unknown): void {
    if (this.closed) {
      throw new TransportClosedError();
    }

    if (params === undefined) {
      this.transport.write({ method });
      return;
    }

    this.transport.write({ method, params });
  }

  initialize(params: InitializeParams): Promise<InitializeResponse> {
    return this.request<"initialize", InitializeResponse>("initialize", params);
  }

  initialized(): void {
    this.notify("initialized");
  }

  async initializeSession(params: Partial<InitializeParams> = {}): Promise<InitializeResponse> {
    const mergedClientInfo = {
      ...DEFAULT_CLIENT_INFO,
      ...(params.clientInfo ?? {}),
      title: params.clientInfo?.title ?? null,
    };
    const mergedCapabilities =
      params.capabilities === null || params.capabilities === undefined
        ? { experimentalApi: true }
        : {
            ...params.capabilities,
            experimentalApi: true,
          };

    const response = await this.initialize({
      clientInfo: mergedClientInfo,
      capabilities: mergedCapabilities,
    });
    this.initialized();
    return response;
  }

  startThread(params: ThreadStartParams): Promise<ThreadStartResponse> {
    return this.request<"thread/start", ThreadStartResponse>("thread/start", params);
  }

  resumeThread(params: ThreadResumeParams): Promise<ThreadResumeResponse> {
    return this.request<"thread/resume", ThreadResumeResponse>("thread/resume", params);
  }

  forkThread(params: ThreadForkParams): Promise<ThreadForkResponse> {
    return this.request<"thread/fork", ThreadForkResponse>("thread/fork", params);
  }

  archiveThread(params: ThreadArchiveParams): Promise<ThreadArchiveResponse> {
    return this.request<"thread/archive", ThreadArchiveResponse>("thread/archive", params);
  }

  listThreads(params: ThreadListParams): Promise<ThreadListResponse> {
    return this.request<"thread/list", ThreadListResponse>("thread/list", params);
  }

  readThread(params: ThreadReadParams): Promise<ThreadReadResponse> {
    return this.request<"thread/read", ThreadReadResponse>("thread/read", params);
  }

  startTurn(params: TurnStartParams): Promise<TurnStartResponse> {
    return this.request<"turn/start", TurnStartResponse>("turn/start", params);
  }

  interruptTurn(params: TurnInterruptParams): Promise<TurnInterruptResponse> {
    return this.request<"turn/interrupt", TurnInterruptResponse>("turn/interrupt", params);
  }

  steerTurn(params: TurnSteerParams): Promise<TurnSteerResponse> {
    return this.request<"turn/steer", TurnSteerResponse>("turn/steer", params);
  }

  listApps(params: AppsListParams): Promise<AppsListResponse> {
    return this.request<"app/list", AppsListResponse>("app/list", params);
  }

  listModels(params: ModelListParams): Promise<ModelListResponse> {
    return this.request<"model/list", ModelListResponse>("model/list", params);
  }

  readConfig(params: ConfigReadParams): Promise<ConfigReadResponse> {
    return this.request<"config/read", ConfigReadResponse>("config/read", params);
  }

  writeConfigValue(params: ConfigValueWriteParams): Promise<ConfigWriteResponse> {
    return this.request<"config/value/write", ConfigWriteResponse>("config/value/write", params);
  }

  writeConfigBatch(params: ConfigBatchWriteParams): Promise<ConfigWriteResponse> {
    return this.request<"config/batchWrite", ConfigWriteResponse>("config/batchWrite", params);
  }

  getAuthStatus(params: GetAuthStatusParams): Promise<GetAuthStatusResponse> {
    return this.request<"getAuthStatus", GetAuthStatusResponse>("getAuthStatus", params);
  }

  readAccount(params: GetAccountParams): Promise<GetAccountResponse> {
    return this.request<"account/read", GetAccountResponse>("account/read", params);
  }

  loginAccount(params: LoginAccountParams): Promise<LoginAccountResponse> {
    return this.request<"account/login/start", LoginAccountResponse>("account/login/start", params);
  }

  listMcpServerStatus(params: ListMcpServerStatusParams): Promise<ListMcpServerStatusResponse> {
    return this.request<"mcpServerStatus/list", ListMcpServerStatusResponse>(
      "mcpServerStatus/list",
      params,
    );
  }

  handleChatgptAuthTokensRefresh(
    handler: (
      params: ChatgptAuthTokensRefreshParams,
    ) => ChatgptAuthTokensRefreshResponse | Promise<ChatgptAuthTokensRefreshResponse>,
  ): Unsubscribe {
    return this.handleServerRequest(
      "account/chatgptAuthTokens/refresh",
      async (context) => await handler(context.request.params),
    );
  }

  async runTurn(
    params: TurnStartParams,
    options: WaitForTurnCompletionOptions = {},
  ): Promise<{
    start: TurnStartResponse;
    completed: TurnCompletedNotification;
  }> {
    const start = await this.startTurn(params);
    const completed = await this.waitForTurnCompletion(start.turn.id, options);
    return { start, completed };
  }

  waitForTurnCompletion(
    turnId: string,
    options: WaitForTurnCompletionOptions = {},
  ): Promise<TurnCompletedNotification> {
    const cached = this.completedTurns.get(turnId);
    if (cached !== undefined) {
      this.completedTurns.delete(turnId);
      return Promise.resolve(cached);
    }

    if (this.closed) {
      return Promise.reject(new TransportClosedError());
    }

    return new Promise<TurnCompletedNotification>((resolve, reject) => {
      const cleanup = (waiter: TurnWaiter): void => {
        if (waiter.timeoutId !== undefined) {
          clearTimeout(waiter.timeoutId);
        }
        if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
          waiter.signal.removeEventListener("abort", waiter.onAbort);
        }
        const waiters = this.turnWaiters.get(turnId);
        if (waiters === undefined) {
          return;
        }
        waiters.delete(waiter);
        if (waiters.size === 0) {
          this.turnWaiters.delete(turnId);
        }
      };

      const waiter: TurnWaiter = {
        resolve: (notification) => {
          cleanup(waiter);
          resolve(notification);
        },
        reject: (error) => {
          cleanup(waiter);
          reject(error);
        },
        signal: options.signal,
      };

      if (options.timeoutMs !== undefined) {
        waiter.timeoutId = setTimeout(() => {
          waiter.reject(new TimeoutError(`Timed out waiting for turn ${turnId} to complete`));
        }, options.timeoutMs);
      }

      if (options.signal !== undefined) {
        waiter.onAbort = () => {
          waiter.reject(options.signal?.reason ?? new Error("Aborted"));
        };
        if (options.signal.aborted) {
          waiter.onAbort();
          return;
        }
        options.signal.addEventListener("abort", waiter.onAbort, { once: true });
      }

      const waiters = this.turnWaiters.get(turnId) ?? new Set<TurnWaiter>();
      waiters.add(waiter);
      this.turnWaiters.set(turnId, waiters);
    });
  }

  onNotification(listener: (notification: ServerNotification) => void): Unsubscribe;
  onNotification<M extends ServerNotification["method"]>(
    method: M,
    listener: (notification: Extract<ServerNotification, { method: M }>) => void,
  ): Unsubscribe;
  onNotification(
    methodOrListener: ServerNotification["method"] | ((notification: ServerNotification) => void),
    maybeListener?: (notification: ServerNotification) => void,
  ): Unsubscribe {
    if (typeof methodOrListener === "function") {
      return this.notificationListeners.subscribe(methodOrListener);
    }

    const bucket =
      this.methodNotificationListeners.get(methodOrListener) ??
      new ListenerSet<[ServerNotification]>();
    this.methodNotificationListeners.set(methodOrListener, bucket);
    return bucket.subscribe(maybeListener as (notification: ServerNotification) => void);
  }

  onServerRequest(listener: ServerRequestListener): Unsubscribe;
  onServerRequest<M extends ServerRequestMethod>(
    method: M,
    listener: ServerRequestListener<M>,
  ): Unsubscribe;
  onServerRequest(
    methodOrListener: ServerRequestMethod | ServerRequestListener,
    maybeListener?: ServerRequestListener,
  ): Unsubscribe {
    if (typeof methodOrListener === "function") {
      return this.serverRequestListeners.subscribe(methodOrListener);
    }

    const bucket =
      this.methodServerRequestListeners.get(methodOrListener) ??
      new ListenerSet<[ServerRequestContext]>();
    this.methodServerRequestListeners.set(methodOrListener, bucket);
    return bucket.subscribe(maybeListener as ServerRequestListener);
  }

  handleServerRequest<M extends ServerRequestMethod>(
    method: M,
    handler: ServerRequestHandler<M>,
  ): Unsubscribe {
    this.serverRequestHandlers.set(method, handler as ServerRequestHandler<any>);
    return () => {
      this.serverRequestHandlers.delete(method);
    };
  }

  onStderr(listener: (chunk: string) => void): Unsubscribe {
    return this.stderrListeners.subscribe(listener);
  }

  onClose(listener: (event: TransportCloseEvent) => void): Unsubscribe {
    return this.closeListeners.subscribe(listener);
  }

  async respondToServerRequest(id: RequestId, result: unknown): Promise<void> {
    this.ensurePendingServerRequest(id);
    this.pendingServerRequests.delete(id);
    this.transport.write({ id, result });
  }

  async respondToServerRequestError(
    id: RequestId,
    error: JsonRpcErrorObject | Error | string,
  ): Promise<void> {
    this.ensurePendingServerRequest(id);
    this.pendingServerRequests.delete(id);
    this.transport.write({ id, error: toJsonRpcErrorObject(error) });
  }

  close(): Promise<TransportCloseEvent> {
    this.closed = true;
    return this.transport.close();
  }

  private async handleMessage(message: JsonRpcMessage): Promise<void> {
    if (isJsonRpcSuccessEnvelope(message)) {
      const pending = this.pendingRequests.get(message.id);
      if (pending !== undefined) {
        this.pendingRequests.delete(message.id);
        pending.resolve(message.result);
      }
      return;
    }

    if (isJsonRpcErrorEnvelope(message)) {
      const pending = this.pendingRequests.get(message.id);
      if (pending !== undefined) {
        this.pendingRequests.delete(message.id);
        pending.reject(
          new JsonRpcRemoteError(
            message.id,
            message.error.code,
            message.error.message,
            message.error.data,
          ),
        );
      }
      return;
    }

    if (isJsonRpcRequestEnvelope(message)) {
      await this.handleServerRequestMessage(message as ServerRequest);
      return;
    }

    if (isJsonRpcNotificationEnvelope(message)) {
      this.handleNotificationMessage(message as ServerNotification);
      return;
    }

    throw new JsonRpcProtocolError(
      "Received an envelope that did not match a known JSON-RPC branch",
    );
  }

  private handleNotificationMessage(notification: ServerNotification): void {
    this.notificationListeners.emit(notification);
    this.methodNotificationListeners.get(notification.method)?.emit(notification);

    if (notification.method === "turn/completed") {
      this.completedTurns.set(notification.params.turn.id, notification.params);
      const waiters = this.turnWaiters.get(notification.params.turn.id);
      if (waiters !== undefined) {
        for (const waiter of [...waiters]) {
          waiter.resolve(notification.params);
        }
      }
      return;
    }

    if (notification.method === "serverRequest/resolved") {
      this.pendingServerRequests.delete(notification.params.requestId);
    }
  }

  private async handleServerRequestMessage(request: ServerRequest): Promise<void> {
    this.pendingServerRequests.set(request.id, request);

    const context = this.createServerRequestContext(request);
    this.serverRequestListeners.emit(context);
    this.methodServerRequestListeners.get(request.method)?.emit(context);

    const handler = this.serverRequestHandlers.get(request.method);
    if (handler !== undefined) {
      try {
        const result = await handler(context);
        if (this.pendingServerRequests.has(request.id)) {
          await this.respondToServerRequest(request.id, result);
        }
      } catch (error) {
        if (this.pendingServerRequests.has(request.id)) {
          await this.respondToServerRequestError(request.id, error as Error);
        }
      }
      return;
    }

    if (
      this.unhandledServerRequestStrategy === "reject" &&
      this.pendingServerRequests.has(request.id)
    ) {
      await this.respondToServerRequestError(request.id, {
        code: -32601,
        message: `Unhandled server request: ${request.method}`,
      });
    }
  }

  private createServerRequestContext<M extends ServerRequestMethod>(
    request: Extract<ServerRequest, { method: M }>,
  ): ServerRequestContext<M> {
    return {
      request,
      respond: async (result: unknown) => {
        await this.respondToServerRequest(request.id, result);
      },
      respondError: async (error: JsonRpcErrorObject | Error | string) => {
        await this.respondToServerRequestError(request.id, error);
      },
    };
  }

  private ensurePendingServerRequest(id: RequestId): void {
    if (!this.pendingServerRequests.has(id)) {
      throw new JsonRpcProtocolError(`No pending server request exists for id ${String(id)}`);
    }
  }

  private rejectAllPending(error: Error, closeEvent?: TransportCloseEvent): void {
    if (closeEvent !== undefined) {
      this.closed = true;
    }

    for (const pending of this.pendingRequests.values()) {
      pending.reject(error);
    }
    this.pendingRequests.clear();
    this.pendingServerRequests.clear();

    for (const [turnId, waiters] of this.turnWaiters.entries()) {
      for (const waiter of waiters) {
        waiter.reject(error);
      }
      this.turnWaiters.delete(turnId);
    }
  }
}
