import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { PassThrough, Writable } from "node:stream";
import { embeddedAgentLog, OPENCLAW_VERSION } from "openclaw/plugin-sdk/agent-harness";
import WebSocket, { type RawData } from "ws";
import {
  codexAppServerStartOptionsKey,
  resolveCodexAppServerRuntimeOptions,
  type CodexAppServerStartOptions,
} from "./config.js";
import {
  type CodexInitializeResponse,
  isRpcResponse,
  type CodexServerNotification,
  type JsonObject,
  type JsonValue,
  type RpcMessage,
  type RpcRequest,
  type RpcResponse,
} from "./protocol.js";

export const MIN_CODEX_APP_SERVER_VERSION = "0.118.0";

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type CodexAppServerTransport = {
  stdin: { write: (data: string) => unknown };
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  killed?: boolean;
  kill?: () => unknown;
  once: (event: string, listener: (...args: unknown[]) => void) => unknown;
};

export type CodexServerRequestHandler = (
  request: Required<Pick<RpcRequest, "id" | "method">> & { params?: JsonValue },
) => Promise<JsonValue | undefined> | JsonValue | undefined;

export type CodexServerNotificationHandler = (
  notification: CodexServerNotification,
) => Promise<void> | void;

export type CodexAppServerModel = {
  id: string;
  model: string;
  displayName?: string;
  description?: string;
  hidden?: boolean;
  isDefault?: boolean;
  inputModalities: string[];
  supportedReasoningEfforts: string[];
  defaultReasoningEffort?: string;
};

export type CodexAppServerModelListResult = {
  models: CodexAppServerModel[];
  nextCursor?: string;
};

export type CodexAppServerListModelsOptions = {
  limit?: number;
  cursor?: string;
  includeHidden?: boolean;
  timeoutMs?: number;
  startOptions?: CodexAppServerStartOptions;
};

export class CodexAppServerClient {
  private readonly child: CodexAppServerTransport;
  private readonly lines: ReadlineInterface;
  private readonly pending = new Map<number | string, PendingRequest>();
  private readonly requestHandlers = new Set<CodexServerRequestHandler>();
  private readonly notificationHandlers = new Set<CodexServerNotificationHandler>();
  private nextId = 1;
  private initialized = false;
  private closed = false;

  private constructor(child: CodexAppServerTransport) {
    this.child = child;
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString("utf8").trim();
      if (text) {
        embeddedAgentLog.debug(`codex app-server stderr: ${text}`);
      }
    });
    child.once("error", (error) =>
      this.closeWithError(error instanceof Error ? error : new Error(String(error))),
    );
    child.once("exit", (code, signal) => {
      this.closeWithError(
        new Error(
          `codex app-server exited: code=${formatExitValue(code)} signal=${formatExitValue(signal)}`,
        ),
      );
    });
  }

  static start(options?: Partial<CodexAppServerStartOptions>): CodexAppServerClient {
    const defaults = resolveCodexAppServerRuntimeOptions().start;
    const startOptions = {
      ...defaults,
      ...options,
      headers: options?.headers ?? defaults.headers,
    };
    if (startOptions.transport === "websocket") {
      return new CodexAppServerClient(createWebSocketTransport(startOptions));
    }
    const child = spawn(startOptions.command, startOptions.args, {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return new CodexAppServerClient(child);
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
    const response = await this.request<CodexInitializeResponse>("initialize", {
      clientInfo: {
        name: "openclaw",
        title: "OpenClaw",
        version: OPENCLAW_VERSION,
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    assertSupportedCodexAppServerVersion(response);
    this.notify("initialized");
    this.initialized = true;
  }

  request<T = JsonValue | undefined>(method: string, params?: JsonValue): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error("codex app-server client is closed"));
    }
    const id = this.nextId++;
    const message: RpcRequest = { id, method, params };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.writeMessage(message);
    });
  }

  notify(method: string, params?: JsonValue): void {
    this.writeMessage({ method, params });
  }

  addRequestHandler(handler: CodexServerRequestHandler): () => void {
    this.requestHandlers.add(handler);
    return () => this.requestHandlers.delete(handler);
  }

  addNotificationHandler(handler: CodexServerNotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  close(): void {
    this.closed = true;
    this.lines.close();
    if (!this.child.killed) {
      this.child.kill?.();
    }
  }

  private writeMessage(message: RpcRequest | RpcResponse): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      embeddedAgentLog.warn("failed to parse codex app-server message", { error });
      return;
    }
    if (!parsed || typeof parsed !== "object") {
      return;
    }
    const message = parsed as RpcMessage;
    if (isRpcResponse(message)) {
      this.handleResponse(message);
      return;
    }
    if (!("method" in message)) {
      return;
    }
    if ("id" in message && message.id !== undefined) {
      void this.handleServerRequest({
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

  private handleResponse(response: RpcResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }
    this.pending.delete(response.id);
    if (response.error) {
      pending.reject(new Error(response.error.message || `${pending.method} failed`));
      return;
    }
    pending.resolve(response.result);
  }

  private async handleServerRequest(
    request: Required<Pick<RpcRequest, "id" | "method">> & { params?: JsonValue },
  ): Promise<void> {
    try {
      for (const handler of this.requestHandlers) {
        const result = await handler(request);
        if (result !== undefined) {
          this.writeMessage({ id: request.id, result });
          return;
        }
      }
      this.writeMessage({ id: request.id, result: defaultServerRequestResponse(request) });
    } catch (error) {
      this.writeMessage({
        id: request.id,
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private handleNotification(notification: CodexServerNotification): void {
    for (const handler of this.notificationHandlers) {
      Promise.resolve(handler(notification)).catch((error: unknown) => {
        embeddedAgentLog.warn("codex app-server notification handler failed", { error });
      });
    }
  }

  private closeWithError(error: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
    clearSharedClientIfCurrent(this);
  }
}

let sharedClient: CodexAppServerClient | undefined;
let sharedClientPromise: Promise<CodexAppServerClient> | undefined;
let sharedClientKey: string | undefined;

export async function getSharedCodexAppServerClient(options?: {
  startOptions?: CodexAppServerStartOptions;
}): Promise<CodexAppServerClient> {
  const startOptions = options?.startOptions ?? resolveCodexAppServerRuntimeOptions().start;
  const key = codexAppServerStartOptionsKey(startOptions);
  if (sharedClientKey && sharedClientKey !== key) {
    clearSharedCodexAppServerClient();
  }
  sharedClientKey = key;
  sharedClientPromise ??= (async () => {
    const client = CodexAppServerClient.start(startOptions);
    sharedClient = client;
    try {
      await client.initialize();
      return client;
    } catch (error) {
      // Startup failures happen before callers own the shared client, so close
      // the child here instead of leaving a rejected daemon attached to stdio.
      client.close();
      throw error;
    }
  })();
  try {
    return await sharedClientPromise;
  } catch (error) {
    sharedClient = undefined;
    sharedClientPromise = undefined;
    sharedClientKey = undefined;
    throw error;
  }
}

export function resetSharedCodexAppServerClientForTests(): void {
  sharedClient = undefined;
  sharedClientPromise = undefined;
  sharedClientKey = undefined;
}

export function clearSharedCodexAppServerClient(): void {
  const client = sharedClient;
  sharedClient = undefined;
  sharedClientPromise = undefined;
  sharedClientKey = undefined;
  client?.close();
}

function clearSharedClientIfCurrent(client: CodexAppServerClient): void {
  if (sharedClient !== client) {
    return;
  }
  sharedClient = undefined;
  sharedClientPromise = undefined;
  sharedClientKey = undefined;
}

export async function listCodexAppServerModels(
  options: CodexAppServerListModelsOptions = {},
): Promise<CodexAppServerModelListResult> {
  const timeoutMs = options.timeoutMs ?? 2500;
  return await withTimeout(
    (async () => {
      const client = await getSharedCodexAppServerClient({ startOptions: options.startOptions });
      const response = await client.request<JsonObject>("model/list", {
        limit: options.limit ?? null,
        cursor: options.cursor ?? null,
        includeHidden: options.includeHidden ?? null,
      });
      return readModelListResult(response);
    })(),
    timeoutMs,
    "codex app-server model/list timed out",
  );
}

export async function requestCodexAppServerJson<T = JsonValue | undefined>(params: {
  method: string;
  requestParams?: JsonValue;
  timeoutMs?: number;
  startOptions?: CodexAppServerStartOptions;
}): Promise<T> {
  const timeoutMs = params.timeoutMs ?? 60_000;
  return await withTimeout(
    (async () => {
      const client = await getSharedCodexAppServerClient({ startOptions: params.startOptions });
      return await client.request<T>(params.method, params.requestParams);
    })(),
    timeoutMs,
    `codex app-server ${params.method} timed out`,
  );
}

export function defaultServerRequestResponse(
  request: Required<Pick<RpcRequest, "id" | "method">> & { params?: JsonValue },
): JsonValue {
  if (request.method === "item/tool/call") {
    return {
      contentItems: [
        {
          type: "inputText",
          text: "OpenClaw did not register a handler for this app-server tool call.",
        },
      ],
      success: false,
    };
  }
  if (
    request.method === "item/commandExecution/requestApproval" ||
    request.method === "item/fileChange/requestApproval"
  ) {
    return { decision: "decline" };
  }
  if (request.method === "item/permissions/requestApproval") {
    return { permissions: {}, scope: "turn" };
  }
  if (isCodexAppServerApprovalRequest(request.method)) {
    return {
      decision: "decline",
      reason: "OpenClaw codex app-server bridge does not grant native approvals yet.",
    };
  }
  if (request.method === "item/tool/requestUserInput") {
    return {
      answers: {},
    };
  }
  if (request.method === "mcpServer/elicitation/request") {
    return {
      action: "decline",
    };
  }
  return {};
}

function readModelListResult(value: JsonValue | undefined): CodexAppServerModelListResult {
  if (!isJsonObjectValue(value) || !Array.isArray(value.data)) {
    return { models: [] };
  }
  const models = value.data
    .map((entry) => readCodexModel(entry))
    .filter((entry): entry is CodexAppServerModel => entry !== undefined);
  const nextCursor = typeof value.nextCursor === "string" ? value.nextCursor : undefined;
  return { models, ...(nextCursor ? { nextCursor } : {}) };
}

function readCodexModel(value: unknown): CodexAppServerModel | undefined {
  if (!isJsonObjectValue(value)) {
    return undefined;
  }
  const id = readNonEmptyString(value.id);
  const model = readNonEmptyString(value.model) ?? id;
  if (!id || !model) {
    return undefined;
  }
  return {
    id,
    model,
    ...(readNonEmptyString(value.displayName)
      ? { displayName: readNonEmptyString(value.displayName) }
      : {}),
    ...(readNonEmptyString(value.description)
      ? { description: readNonEmptyString(value.description) }
      : {}),
    ...(typeof value.hidden === "boolean" ? { hidden: value.hidden } : {}),
    ...(typeof value.isDefault === "boolean" ? { isDefault: value.isDefault } : {}),
    inputModalities: readStringArray(value.inputModalities),
    supportedReasoningEfforts: readReasoningEfforts(value.supportedReasoningEfforts),
    ...(readNonEmptyString(value.defaultReasoningEffort)
      ? { defaultReasoningEffort: readNonEmptyString(value.defaultReasoningEffort) }
      : {}),
  };
}

function readReasoningEfforts(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const efforts = value
    .map((entry) => {
      if (!isJsonObjectValue(entry)) {
        return undefined;
      }
      return readNonEmptyString(entry.reasoningEffort);
    })
    .filter((entry): entry is string => entry !== undefined);
  return [...new Set(efforts)];
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [
    ...new Set(
      value
        .map((entry) => readNonEmptyString(entry))
        .filter((entry): entry is string => entry !== undefined),
    ),
  ];
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function isJsonObjectValue(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function assertSupportedCodexAppServerVersion(response: CodexInitializeResponse): void {
  const detectedVersion = readCodexVersionFromUserAgent(response.userAgent);
  if (!detectedVersion) {
    throw new Error(
      `Codex app-server ${MIN_CODEX_APP_SERVER_VERSION} or newer is required, but OpenClaw could not determine the running Codex version. Upgrade Codex CLI and retry.`,
    );
  }
  if (compareVersions(detectedVersion, MIN_CODEX_APP_SERVER_VERSION) < 0) {
    throw new Error(
      `Codex app-server ${MIN_CODEX_APP_SERVER_VERSION} or newer is required, but detected ${detectedVersion}. Upgrade Codex CLI and retry.`,
    );
  }
}

export function readCodexVersionFromUserAgent(userAgent: string | undefined): string | undefined {
  // Codex returns `<originator>/<codex-version> ...`; the originator can be
  // OpenClaw or an env override, so only the slash-delimited version is stable.
  const match = userAgent?.match(/^[^/\s]+\/(\d+\.\d+\.\d+(?:[-+][^\s()]*)?)/);
  return match?.[1];
}

function compareVersions(left: string, right: string): number {
  const leftParts = numericVersionParts(left);
  const rightParts = numericVersionParts(right);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;
    if (leftPart !== rightPart) {
      return leftPart < rightPart ? -1 : 1;
    }
  }
  return 0;
}

function numericVersionParts(version: string): number[] {
  // Pre-release/build tags do not affect our minimum gate; 0.118.0-dev should
  // satisfy the same protocol floor as 0.118.0.
  return version
    .split(/[+-]/, 1)[0]
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return await promise;
  }
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(timeoutMessage)), Math.max(1, timeoutMs));
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export function isCodexAppServerApprovalRequest(method: string): boolean {
  return method.includes("requestApproval") || method.includes("Approval");
}

function formatExitValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  return "unknown";
}

function createWebSocketTransport(options: CodexAppServerStartOptions): CodexAppServerTransport {
  if (!options.url) {
    throw new Error(
      "codex app-server websocket transport requires plugins.entries.codex.config.appServer.url",
    );
  }
  const events = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const headers = {
    ...options.headers,
    ...(options.authToken ? { Authorization: `Bearer ${options.authToken}` } : {}),
  };
  const socket = new WebSocket(options.url, { headers });
  const pendingFrames: string[] = [];
  let killed = false;

  const sendFrame = (frame: string) => {
    const trimmed = frame.trim();
    if (!trimmed) {
      return;
    }
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(trimmed);
      return;
    }
    pendingFrames.push(trimmed);
  };

  // `initialize` can be written before the WebSocket open event fires. Buffer
  // whole JSON-RPC frames so stdio and websocket transports share call timing.
  socket.once("open", () => {
    for (const frame of pendingFrames.splice(0)) {
      socket.send(frame);
    }
  });
  socket.once("error", (error) => events.emit("error", error));
  socket.once("close", (code, reason) => {
    killed = true;
    events.emit("exit", code, reason.toString("utf8"));
  });
  socket.on("message", (data) => {
    const text = websocketFrameToText(data);
    stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  });

  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      for (const frame of chunk.toString("utf8").split("\n")) {
        sendFrame(frame);
      }
      callback();
    },
  });

  return {
    stdin,
    stdout,
    stderr,
    get killed() {
      return killed;
    },
    kill: () => {
      killed = true;
      socket.close();
    },
    once: (event, listener) => events.once(event, listener),
  };
}

function websocketFrameToText(data: RawData): string {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}
