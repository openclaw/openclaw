import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import type { IncomingMessage } from "node:http";
import { isIP, type AddressInfo } from "node:net";
import { posix as pathPosix } from "node:path";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { type SandboxContext, type SandboxFsStat } from "openclaw/plugin-sdk/sandbox";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { compareCodexAppServerVersions, type CodexAppServerClient } from "./client.js";
import type { CodexAppServerStartOptions } from "./config.js";
import type { JsonObject, JsonValue } from "./protocol.js";
import { MIN_CODEX_SANDBOX_EXEC_SERVER_APP_SERVER_VERSION } from "./version.js";

type JsonRpcRequest = {
  id?: string | number;
  method?: string;
  params?: JsonValue;
};

type ProcessChunk = {
  seq: number;
  stream: "stdout" | "stderr" | "pty";
  chunk: string;
};

type DirectoryEntry = {
  fileName: string;
  isDirectory: boolean;
  isFile: boolean;
};

type FsAccessMode = "read" | "write" | "none";

type ResolvedFsSandboxEntry =
  | {
      kind: "path";
      path: string;
      access: FsAccessMode;
    }
  | {
      kind: "glob";
      pattern: string;
      matcher: RegExp;
      literalPrefix: string;
      access: FsAccessMode;
    };

type ResolvedFsSandboxPolicy = {
  unrestricted: boolean;
  entries: ResolvedFsSandboxEntry[];
};

type HttpHeader = {
  name: string;
  value: string;
};

type ManagedProcess = {
  processId: string;
  chunks: ProcessChunk[];
  retainedOutputBytes: number;
  nextSeq: number;
  exited: boolean;
  exitCode: number | null;
  closed: boolean;
  failure: string | null;
  tty: boolean;
  pipeStdin: boolean;
  abortController: AbortController;
  child: ChildProcessWithoutNullStreams | null;
  finalizeToken?: unknown;
  finalizeExec?: NonNullable<SandboxContext["backend"]>["finalizeExec"];
  finalized: boolean;
  evictionTimer?: ReturnType<typeof setTimeout>;
  waiters: Array<() => void>;
  emitNotification: (method: string, params: JsonObject) => void;
  evictProcess: () => void;
};

type OpenClawExecServer = {
  environmentId: string;
  authPath: string;
  refCount: number;
  closed: boolean;
  url: string;
  sandbox: SandboxContext;
  server: WebSocketServer;
};

export type CodexSandboxExecEnvironment = {
  environmentId: string;
  cwd: string;
};

const SANDBOX_EXEC_SERVERS = new Map<string, Promise<OpenClawExecServer>>();
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RETAINED_PROCESS_OUTPUT_BYTES = 1024 * 1024;
const CLOSED_PROCESS_EVICTION_MS = 60_000;
const CODEX_SANDBOX_EXEC_SERVER_MAX_READ_FILE_BYTES = 512 * 1024 * 1024;
const JSON_RPC_NOT_FOUND = -32004;

class JsonRpcProtocolError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export async function closeCodexSandboxExecServersForTests(): Promise<void> {
  const servers = await Promise.allSettled(SANDBOX_EXEC_SERVERS.values());
  SANDBOX_EXEC_SERVERS.clear();
  await Promise.all(
    servers.map(async (entry) => {
      if (entry.status === "fulfilled") {
        entry.value.refCount = 0;
        await closeOpenClawExecServer(entry.value);
      }
    }),
  );
}

export async function ensureCodexSandboxExecServerEnvironment(params: {
  client: CodexAppServerClient;
  sandbox: SandboxContext | null;
  appServerStartOptions?: CodexAppServerStartOptions;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<CodexSandboxExecEnvironment | undefined> {
  if (!params.sandbox?.enabled || !params.sandbox.backend) {
    return undefined;
  }
  if (!canExposeLocalExecServerToAppServer(params.appServerStartOptions)) {
    throw new Error(
      "OpenClaw Codex exec-server uses a local loopback URL and cannot be registered with a remote Codex app-server.",
    );
  }
  assertCodexSandboxExecServerSupported(params.client);
  const execServer = await acquireOpenClawExecServer(params.sandbox);
  try {
    await params.client.request(
      "environment/add",
      {
        environmentId: execServer.environmentId,
        execServerUrl: execServer.url,
      },
      { timeoutMs: params.timeoutMs, signal: params.signal },
    );
  } catch (error) {
    await releaseOpenClawExecServer(execServer);
    if (isEnvironmentAddUnsupported(error)) {
      embeddedAgentLog.warn("codex app-server does not support remote environments yet", {
        environmentId: execServer.environmentId,
      });
      return undefined;
    }
    throw error;
  }
  return {
    environmentId: execServer.environmentId,
    cwd: params.sandbox.containerWorkdir,
  };
}

export async function releaseCodexSandboxExecServerEnvironment(
  sandbox: SandboxContext | null | undefined,
): Promise<void> {
  if (!sandbox?.enabled) {
    return;
  }
  const server = await SANDBOX_EXEC_SERVERS.get(sandbox.runtimeId)?.catch(() => undefined);
  if (server) {
    await releaseOpenClawExecServer(server);
  }
}

function assertCodexSandboxExecServerSupported(client: CodexAppServerClient): void {
  const detectedVersion = client.getServerVersion();
  if (
    !detectedVersion ||
    compareCodexAppServerVersions(
      detectedVersion,
      MIN_CODEX_SANDBOX_EXEC_SERVER_APP_SERVER_VERSION,
    ) < 0
  ) {
    throw new Error(
      `Codex app-server ${MIN_CODEX_SANDBOX_EXEC_SERVER_APP_SERVER_VERSION} or newer is required for OpenClaw sandbox exec-server environments, but detected ${
        detectedVersion ?? "an unknown version"
      }. Disable appServer.experimental.sandboxExecServer or configure a newer Codex app-server binary.`,
    );
  }
}

function isEnvironmentAddUnsupported(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.message.includes("environment/add") &&
    (error.message.includes("unknown variant") || error.message.includes("Method not found"))
  );
}

function canExposeLocalExecServerToAppServer(
  startOptions: CodexAppServerStartOptions | undefined,
): boolean {
  if (!startOptions || startOptions.transport !== "websocket") {
    return true;
  }
  if (typeof startOptions.url !== "string") {
    return false;
  }
  try {
    const host = new URL(startOptions.url).hostname.toLowerCase();
    const ipHost = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
    if (host === "localhost" || ipHost === "::1") {
      return true;
    }
    return isIP(ipHost) === 4 && ipHost.split(".")[0] === "127";
  } catch {
    return false;
  }
}

async function acquireOpenClawExecServer(sandbox: SandboxContext): Promise<OpenClawExecServer> {
  const key = sandbox.runtimeId;
  while (true) {
    const existing = SANDBOX_EXEC_SERVERS.get(key);
    const promise = existing ?? startAndRememberOpenClawExecServer(sandbox);
    const server = await promise;
    if (!server.closed && SANDBOX_EXEC_SERVERS.get(key) === promise) {
      server.refCount += 1;
      return server;
    }
  }
}

function startAndRememberOpenClawExecServer(sandbox: SandboxContext): Promise<OpenClawExecServer> {
  const created = startOpenClawExecServer(sandbox);
  const key = sandbox.runtimeId;
  SANDBOX_EXEC_SERVERS.set(key, created);
  void created.catch(() => {
    if (SANDBOX_EXEC_SERVERS.get(key) === created) {
      SANDBOX_EXEC_SERVERS.delete(key);
    }
  });
  return created;
}

async function startOpenClawExecServer(sandbox: SandboxContext): Promise<OpenClawExecServer> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("OpenClaw Codex exec-server did not bind to a TCP port.");
  }
  const environmentId = buildEnvironmentId(sandbox);
  const authPath = `/openclaw-${randomUUID()}`;
  const url = `ws://127.0.0.1:${(address as AddressInfo).port}${authPath}`;
  const execServer: OpenClawExecServer = {
    authPath,
    closed: false,
    environmentId,
    refCount: 0,
    url,
    sandbox,
    server,
  };
  server.on("connection", (socket, request) => {
    if (!isAuthorizedExecServerRequest(execServer, request)) {
      socket.close(1008, "unauthorized");
      return;
    }
    handleConnection(execServer, socket);
  });
  embeddedAgentLog.info("codex sandbox exec-server started", {
    environmentId,
    runtimeId: sandbox.runtimeId,
    backendId: sandbox.backendId,
  });
  return execServer;
}

async function releaseOpenClawExecServer(execServer: OpenClawExecServer): Promise<void> {
  if (execServer.closed) {
    return;
  }
  execServer.refCount = Math.max(0, execServer.refCount - 1);
  if (execServer.refCount > 0) {
    return;
  }
  const current = await SANDBOX_EXEC_SERVERS.get(execServer.sandbox.runtimeId)?.catch(
    () => undefined,
  );
  if (execServer.refCount > 0 || execServer.closed) {
    return;
  }
  if (current === execServer) {
    SANDBOX_EXEC_SERVERS.delete(execServer.sandbox.runtimeId);
  }
  await closeOpenClawExecServer(execServer);
}

async function closeOpenClawExecServer(execServer: OpenClawExecServer): Promise<void> {
  if (execServer.closed) {
    return;
  }
  execServer.closed = true;
  for (const client of execServer.server.clients) {
    client.close(1001, "shutdown");
  }
  await new Promise<void>((resolve) => {
    execServer.server.close(() => resolve());
  });
}

function buildEnvironmentId(sandbox: SandboxContext): string {
  const hash = createHash("sha256").update(sandbox.runtimeId).digest("hex").slice(0, 16);
  return `openclaw-sandbox-${hash}`;
}

function isAuthorizedExecServerRequest(
  execServer: OpenClawExecServer,
  request: IncomingMessage,
): boolean {
  const url = new URL(request.url ?? "", "ws://127.0.0.1");
  return url.pathname === execServer.authPath;
}

function handleConnection(execServer: OpenClawExecServer, socket: WebSocket): void {
  const processes = new Map<string, ManagedProcess>();
  socket.on("message", (data) => {
    void handleMessage(execServer, processes, socket, data).catch((error: unknown) => {
      embeddedAgentLog.warn("codex sandbox exec-server message failed", { error });
    });
  });
  socket.on("close", () => {
    for (const process of processes.values()) {
      process.abortController.abort();
    }
  });
}

async function handleMessage(
  execServer: OpenClawExecServer,
  processes: Map<string, ManagedProcess>,
  socket: WebSocket,
  data: RawData,
): Promise<void> {
  const request = parseRequest(data);
  if (!request.method) {
    sendError(socket, request.id, -32600, "Invalid Request");
    return;
  }
  const method = request.method;
  if (request.id === undefined) {
    if (method !== "initialized") {
      sendError(socket, -1, -32600, `Unexpected notification: ${method}`);
    }
    return;
  }
  try {
    const result = await dispatchRequest(execServer, processes, socket, { ...request, method });
    sendResult(socket, request.id, result);
  } catch (error) {
    sendError(
      socket,
      request.id,
      error instanceof JsonRpcProtocolError ? error.code : -32603,
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function dispatchRequest(
  execServer: OpenClawExecServer,
  processes: Map<string, ManagedProcess>,
  socket: WebSocket,
  request: Required<Pick<JsonRpcRequest, "method">> & Pick<JsonRpcRequest, "id" | "params">,
): Promise<JsonValue | undefined> {
  switch (request.method) {
    case "initialize":
      return { sessionId: randomUUID() };
    // These method names are the Codex exec-server remote-environment RPCs.
    // The app-server process-control surface uses different names such as
    // process/spawn, but those are not sent to registered exec-server URLs.
    case "process/start":
      return startProcess(execServer, processes, socket, request.params);
    case "process/read":
      return await readProcess(processes, request.params);
    case "process/write":
      return writeProcess(processes, request.params);
    case "process/terminate":
      return terminateProcess(processes, request.params);
    case "fs/readFile":
      return await readFile(execServer, request.params);
    case "fs/writeFile":
      await writeFile(execServer, request.params);
      return {};
    case "fs/createDirectory":
      await createDirectory(execServer, request.params);
      return {};
    case "fs/getMetadata":
      return await getMetadata(execServer, request.params);
    case "fs/readDirectory":
      return await readDirectory(execServer, request.params);
    case "fs/remove":
      await removePath(execServer, request.params);
      return {};
    case "fs/copy":
      await copyPath(execServer, request.params);
      return {};
    case "http/request":
      return await httpRequest(execServer, socket, request.params);
    default:
      throw new Error(`Unsupported OpenClaw sandbox exec-server method: ${request.method}`);
  }
}

async function startProcess(
  execServer: OpenClawExecServer,
  processes: Map<string, ManagedProcess>,
  socket: WebSocket,
  params: JsonValue | undefined,
): Promise<JsonObject> {
  const record = requireObject(params, "process/start params");
  const processId = requireString(record.processId, "processId");
  if (processes.has(processId)) {
    throw new Error(`process already exists: ${processId}`);
  }
  const argv = requireStringArray(record.argv, "argv");
  const cwd = requireString(record.cwd, "cwd");
  rejectUnsupportedArg0(record.arg0);
  const env = readProcessEnv(record);
  const tty = record.tty === true;
  const pipeStdin = record.pipeStdin === true;
  const managed: ManagedProcess = {
    processId,
    chunks: [],
    retainedOutputBytes: 0,
    nextSeq: 1,
    exited: false,
    exitCode: null,
    closed: false,
    failure: null,
    tty,
    pipeStdin,
    abortController: new AbortController(),
    child: null,
    finalized: false,
    waiters: [],
    emitNotification: (method, notificationParams) => {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify({ jsonrpc: "2.0", method, params: notificationParams }));
      }
    },
    evictProcess: () => {
      if (managed.evictionTimer) {
        return;
      }
      managed.evictionTimer = setTimeout(() => {
        if (processes.get(processId) === managed && managed.closed) {
          processes.delete(processId);
        }
      }, CLOSED_PROCESS_EVICTION_MS);
      managed.evictionTimer.unref?.();
    },
  };
  processes.set(processId, managed);
  try {
    await runProcess(execServer, managed, { argv, cwd, env });
  } catch (error) {
    processes.delete(processId);
    managed.failure = error instanceof Error ? error.message : String(error);
    managed.exitCode = null;
    managed.exited = true;
    managed.closed = true;
    notifyProcessWaiters(managed);
    throw error;
  }
  return { processId };
}

async function runProcess(
  execServer: OpenClawExecServer,
  managed: ManagedProcess,
  params: { argv: string[]; cwd: string; env: Record<string, string> },
): Promise<void> {
  const backend = execServer.sandbox.backend;
  if (!backend) {
    throw new Error("OpenClaw sandbox backend is unavailable.");
  }
  throwIfProcessStartCancelled(managed);
  const execSpec = await backend.buildExecSpec({
    command: shellCommandFromArgv(params.argv),
    workdir: params.cwd,
    env: params.env,
    // This bridge currently owns only pipe-backed child processes. Asking the
    // backend for a PTY can produce commands such as `docker exec -t`, which
    // require this process itself to own a real TTY.
    usePty: false,
  });
  managed.finalizeToken = execSpec.finalizeToken;
  managed.finalizeExec = backend.finalizeExec;
  if (managed.abortController.signal.aborted) {
    managed.failure = "process start cancelled";
    await finalizeProcess(managed);
    throw new Error("process start cancelled");
  }
  const [command, ...args] = execSpec.argv;
  if (!command) {
    throw new Error("OpenClaw sandbox exec spec did not provide a command.");
  }
  const child = spawn(command, args, {
    env: execSpec.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  managed.child = child;
  const abortListener = () => child.kill("SIGTERM");
  managed.abortController.signal.addEventListener("abort", abortListener, { once: true });
  child.stdout.on("data", (chunk: Buffer) =>
    appendProcessChunk(managed, managed.tty ? "pty" : "stdout", chunk),
  );
  child.stderr.on("data", (chunk: Buffer) => appendProcessChunk(managed, "stderr", chunk));
  child.once("error", (error) => {
    managed.failure = error.message;
    emitProcessClosed(managed, null);
  });
  child.once("close", (code) => {
    managed.abortController.signal.removeEventListener("abort", abortListener);
    emitProcessClosed(managed, code ?? 1);
  });
  if (!managed.tty && !managed.pipeStdin) {
    child.stdin.end();
  }
}

function throwIfProcessStartCancelled(managed: ManagedProcess): void {
  if (managed.abortController.signal.aborted) {
    throw new Error("process start cancelled");
  }
}

function appendProcessChunk(
  managed: ManagedProcess,
  stream: ProcessChunk["stream"],
  data: Buffer,
): void {
  if (data.length === 0) {
    return;
  }
  const chunk = {
    seq: managed.nextSeq,
    stream,
    chunk: data.toString("base64"),
  };
  managed.chunks.push(chunk);
  managed.retainedOutputBytes += data.length;
  while (managed.retainedOutputBytes > RETAINED_PROCESS_OUTPUT_BYTES && managed.chunks.length > 1) {
    const removed = managed.chunks.shift();
    if (!removed) {
      break;
    }
    managed.retainedOutputBytes -= Buffer.from(removed.chunk, "base64").byteLength;
  }
  managed.nextSeq += 1;
  managed.emitNotification("process/output", {
    processId: managed.processId,
    seq: chunk.seq,
    stream: chunk.stream,
    chunk: chunk.chunk,
  });
  notifyProcessWaiters(managed);
}

function emitProcessClosed(managed: ManagedProcess, exitCode: number | null): void {
  if (!managed.exited) {
    const exitSeq = managed.nextSeq;
    managed.nextSeq += 1;
    managed.exitCode = exitCode;
    managed.exited = true;
    if (exitCode !== null) {
      managed.emitNotification("process/exited", {
        processId: managed.processId,
        seq: exitSeq,
        exitCode,
      });
    }
  }
  if (!managed.closed) {
    const closeSeq = managed.nextSeq;
    managed.nextSeq += 1;
    managed.closed = true;
    managed.emitNotification("process/closed", {
      processId: managed.processId,
      seq: closeSeq,
    });
  }
  void finalizeProcess(managed).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    managed.failure ??= message;
    embeddedAgentLog.warn("codex sandbox exec-server finalize failed", {
      processId: managed.processId,
      error: message,
    });
  });
  managed.evictProcess();
  notifyProcessWaiters(managed);
}

async function finalizeProcess(managed: ManagedProcess): Promise<void> {
  if (managed.finalized) {
    return;
  }
  managed.finalized = true;
  managed.child?.stdin.destroy();
  await managed.finalizeExec?.({
    status: managed.failure ? "failed" : "completed",
    exitCode: managed.exitCode,
    timedOut: false,
    token: managed.finalizeToken,
  });
}

function limitProcessChunks(chunks: ProcessChunk[], maxBytes: number | undefined): ProcessChunk[] {
  if (!maxBytes) {
    return chunks;
  }
  const retained: ProcessChunk[] = [];
  let retainedBytes = 0;
  for (const chunk of chunks) {
    const byteLength = Buffer.from(chunk.chunk, "base64").byteLength;
    if (retained.length > 0 && retainedBytes + byteLength > maxBytes) {
      break;
    }
    retained.push(chunk);
    retainedBytes += byteLength;
    if (retainedBytes >= maxBytes) {
      break;
    }
  }
  return retained;
}

async function readProcess(
  processes: Map<string, ManagedProcess>,
  params: JsonValue | undefined,
): Promise<JsonObject> {
  const record = requireObject(params, "process/read params");
  const processId = requireString(record.processId, "processId");
  const managed = requireProcess(processes, processId);
  const afterSeq = typeof record.afterSeq === "number" ? record.afterSeq : 0;
  const waitMs = typeof record.waitMs === "number" && record.waitMs > 0 ? record.waitMs : 0;
  if (!managed.exited && !hasChunksAtOrAfter(managed, afterSeq) && waitMs > 0) {
    await waitForProcessUpdate(managed, waitMs);
  }
  const chunks = limitProcessChunks(
    managed.chunks.filter((chunk) => chunk.seq > afterSeq),
    typeof record.maxBytes === "number" && record.maxBytes > 0 ? record.maxBytes : undefined,
  );
  const lastChunk = chunks.at(-1);
  return {
    chunks,
    nextSeq: lastChunk ? lastChunk.seq + 1 : managed.nextSeq,
    exited: managed.exited,
    exitCode: managed.exitCode,
    closed: managed.closed,
    failure: managed.failure,
  };
}

function writeProcess(
  processes: Map<string, ManagedProcess>,
  params: JsonValue | undefined,
): JsonObject {
  const record = requireObject(params, "process/write params");
  const processId = requireString(record.processId, "processId");
  const managed = processes.get(processId);
  if (!managed) {
    return { status: "unknownProcess" };
  }
  const chunk = Buffer.from(requireString(record.chunk, "chunk"), "base64");
  if ((!managed.tty && !managed.pipeStdin) || managed.closed || !managed.child?.stdin.writable) {
    return { status: "stdinClosed" };
  }
  managed.child.stdin.write(chunk);
  return { status: "accepted" };
}

function terminateProcess(
  processes: Map<string, ManagedProcess>,
  params: JsonValue | undefined,
): JsonObject {
  const record = requireObject(params, "process/terminate params");
  const processId = requireString(record.processId, "processId");
  const managed = processes.get(processId);
  if (!managed) {
    return { running: false };
  }
  const running = !managed.exited;
  managed.abortController.abort();
  managed.child?.kill("SIGTERM");
  if (running && !managed.child) {
    emitProcessClosed(managed, null);
  }
  return { running };
}

async function readFile(
  execServer: OpenClawExecServer,
  params: JsonValue | undefined,
): Promise<JsonObject> {
  const record = requireObject(params, "fs/readFile params");
  const filePath = requireString(record.path, "path");
  assertFsSandboxAccess(execServer, record, [{ path: filePath, access: "read" }]);
  const fsBridge = requireFsBridge(execServer);
  const stat = await fsBridge.stat({ filePath });
  if (!stat) {
    throw new JsonRpcProtocolError(JSON_RPC_NOT_FOUND, "file not found");
  }
  if (stat.type === "file" && stat.size > CODEX_SANDBOX_EXEC_SERVER_MAX_READ_FILE_BYTES) {
    throw new Error(
      `file is too large to read through Codex sandbox exec-server: ${stat.size} bytes`,
    );
  }
  const data = await fsBridge.readFile({
    filePath,
  });
  return { dataBase64: data.toString("base64") };
}

async function writeFile(
  execServer: OpenClawExecServer,
  params: JsonValue | undefined,
): Promise<void> {
  const record = requireObject(params, "fs/writeFile params");
  const filePath = requireString(record.path, "path");
  assertFsSandboxAccess(execServer, record, [{ path: filePath, access: "write" }]);
  const fsBridge = requireFsBridge(execServer);
  const parent = await fsBridge.stat({ filePath: pathPosix.dirname(filePath) });
  if (parent?.type !== "directory") {
    throw new JsonRpcProtocolError(JSON_RPC_NOT_FOUND, "parent directory not found");
  }
  await fsBridge.writeFile({
    filePath,
    data: Buffer.from(requireBase64String(record.dataBase64, "dataBase64"), "base64"),
    mkdir: false,
  });
}

async function createDirectory(
  execServer: OpenClawExecServer,
  params: JsonValue | undefined,
): Promise<void> {
  const record = requireObject(params, "fs/createDirectory params");
  const filePath = requireString(record.path, "path");
  assertFsSandboxAccess(execServer, record, [{ path: filePath, access: "write" }]);
  const fsBridge = requireFsBridge(execServer);
  if (record.recursive === false) {
    const parentPath = pathPosix.dirname(filePath);
    const parent = await fsBridge.stat({ filePath: parentPath });
    if (parent?.type !== "directory") {
      throw new JsonRpcProtocolError(JSON_RPC_NOT_FOUND, "parent directory not found");
    }
  }
  await fsBridge.mkdirp({
    filePath,
  });
}

async function getMetadata(
  execServer: OpenClawExecServer,
  params: JsonValue | undefined,
): Promise<JsonObject> {
  const record = requireObject(params, "fs/getMetadata params");
  const filePath = requireString(record.path, "path");
  assertFsSandboxAccess(execServer, record, [{ path: filePath, access: "read" }]);
  const fsBridge = requireFsBridge(execServer);
  const stat = await fsBridge.stat({
    filePath,
  });
  if (!stat) {
    throw new JsonRpcProtocolError(JSON_RPC_NOT_FOUND, "file not found");
  }
  return metadataResponse(stat);
}

async function httpRequest(
  execServer: OpenClawExecServer,
  socket: WebSocket,
  params: JsonValue | undefined,
): Promise<JsonObject> {
  const record = requireObject(params, "http/request params");
  const requestId = requireString(record.requestId, "requestId");
  const request = {
    method: requireString(record.method, "method"),
    url: requireString(record.url, "url"),
    headers: readHttpHeaders(record.headers),
    bodyBase64: typeof record.bodyBase64 === "string" ? record.bodyBase64 : undefined,
    timeoutMs:
      typeof record.timeoutMs === "number" && record.timeoutMs > 0
        ? Math.floor(record.timeoutMs)
        : undefined,
    streamResponse: record.streamResponse === true,
  };
  if (request.streamResponse) {
    return await runStreamingSandboxHttpRequest(execServer, socket, requestId, request);
  }
  const result = await runSandboxHttpRequest(execServer, {
    ...request,
    streamResponse: false,
  });
  return result;
}

type SandboxHttpRequest = {
  method: string;
  url: string;
  headers: HttpHeader[];
  bodyBase64?: string;
  timeoutMs?: number;
  streamResponse: boolean;
};

async function runSandboxHttpRequest(
  execServer: OpenClawExecServer,
  params: SandboxHttpRequest,
): Promise<JsonObject & { status: number; headers: HttpHeader[]; bodyBase64: string }> {
  const backend = requireBackend(execServer);
  const result = await backend.runShellCommand({
    script: SANDBOX_HTTP_REQUEST_SCRIPT,
    stdin: JSON.stringify(params),
    allowFailure: true,
  });
  if (result.code !== 0) {
    const stderr = result.stderr.toString("utf8").trim();
    throw new Error(stderr || `sandbox http/request failed with code ${result.code}`);
  }
  const parsed = JSON.parse(result.stdout.toString("utf8")) as {
    status?: unknown;
    headers?: unknown;
    bodyBase64?: unknown;
  };
  if (typeof parsed.status !== "number" || !Array.isArray(parsed.headers)) {
    throw new Error("sandbox http/request returned an invalid response envelope");
  }
  return {
    status: parsed.status,
    headers: readHttpHeaders(parsed.headers),
    bodyBase64: typeof parsed.bodyBase64 === "string" ? parsed.bodyBase64 : "",
  };
}

async function runStreamingSandboxHttpRequest(
  execServer: OpenClawExecServer,
  socket: WebSocket,
  requestId: string,
  params: SandboxHttpRequest,
): Promise<JsonObject> {
  const backend = requireBackend(execServer);
  const execSpec = await backend.buildExecSpec({
    command: SANDBOX_HTTP_REQUEST_SCRIPT,
    workdir: execServer.sandbox.containerWorkdir,
    env: {},
    usePty: false,
  });
  const [command, ...args] = execSpec.argv;
  if (!command) {
    throw new Error("OpenClaw sandbox HTTP exec spec did not provide a command.");
  }

  const child = spawn(command, args, {
    env: execSpec.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const abortOnSocketClose = () => child.kill("SIGTERM");
  socket.once("close", abortOnSocketClose);
  child.once("close", () => {
    socket.off("close", abortOnSocketClose);
  });
  child.stdin.end(JSON.stringify(params));
  return await readStreamingSandboxHttpResponse({
    child,
    execSpec,
    finalizeExec: backend.finalizeExec,
    requestId,
    socket,
  });
}

function readStreamingSandboxHttpResponse(params: {
  child: ChildProcessWithoutNullStreams;
  execSpec: { finalizeToken?: unknown };
  finalizeExec?: NonNullable<SandboxContext["backend"]>["finalizeExec"];
  requestId: string;
  socket: WebSocket;
}): Promise<JsonObject> {
  return new Promise((resolve, reject) => {
    let headerResolved = false;
    let failed = false;
    let lastBodySeq = 0;
    let stdoutBuffer = "";
    let stderr = "";
    const finalize = async (status: "completed" | "failed", exitCode: number | null) => {
      await params.finalizeExec?.({
        status,
        exitCode,
        timedOut: false,
        token: params.execSpec.finalizeToken,
      });
    };
    const fail = (message: string, exitCode: number | null) => {
      if (failed) {
        return;
      }
      failed = true;
      void finalize("failed", exitCode).catch((error: unknown) => {
        embeddedAgentLog.warn("codex sandbox http/request finalize failed", { error });
      });
      if (headerResolved) {
        sendHttpBodyDelta(params.socket, {
          requestId: params.requestId,
          seq: lastBodySeq + 1,
          deltaBase64: "",
          done: true,
          error: message,
        });
        return;
      }
      reject(new Error(message));
    };
    params.child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      let newline = stdoutBuffer.indexOf("\n");
      while (newline >= 0) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (line) {
          try {
            const message = requireObject(JSON.parse(line) as JsonValue, "http stream message");
            const type = requireString(message.type, "http stream message type");
            if (type === "headers") {
              headerResolved = true;
              resolve({
                status: requireNumber(message.status, "http status"),
                headers: readHttpHeaders(message.headers),
                bodyBase64: "",
              });
            } else if (type === "bodyDelta") {
              const seq = requireNumber(message.seq, "http body sequence");
              lastBodySeq = Math.max(lastBodySeq, seq);
              sendHttpBodyDelta(params.socket, {
                requestId: params.requestId,
                seq,
                deltaBase64: typeof message.deltaBase64 === "string" ? message.deltaBase64 : "",
                done: message.done === true,
                error: typeof message.error === "string" ? message.error : null,
              });
            }
          } catch (error) {
            fail(error instanceof Error ? error.message : String(error), null);
          }
        }
        newline = stdoutBuffer.indexOf("\n");
      }
    });
    params.child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4096);
    });
    params.child.once("error", (error) => fail(error.message, null));
    params.child.once("close", (code) => {
      const exitCode = code ?? 1;
      if (failed) {
        return;
      }
      if (exitCode === 0) {
        void finalize("completed", exitCode).catch((error: unknown) => {
          embeddedAgentLog.warn("codex sandbox http/request finalize failed", { error });
        });
        if (!headerResolved) {
          reject(new Error("sandbox http/request exited before returning headers"));
        }
        return;
      }
      fail(stderr.trim() || `sandbox http/request failed with code ${exitCode}`, exitCode);
    });
  });
}

const SANDBOX_HTTP_REQUEST_SCRIPT = String.raw`
tmp=$(mktemp "$TMPDIR/openclaw-http.XXXXXX.py" 2>/dev/null || mktemp "/tmp/openclaw-http.XXXXXX.py") || exit 1
trap 'rm -f "$tmp"' EXIT
cat > "$tmp" <<'PY'
import base64
import json
import sys
import urllib.error
import urllib.parse
import urllib.request

def emit(payload):
    print(json.dumps(payload, separators=(",", ":")), flush=True)

def response_headers(response):
    return [{"name": name, "value": value} for name, value in response.headers.items()]

def handle_response(input_data, response):
    headers = response_headers(response)
    status = int(getattr(response, "status", getattr(response, "code", 0)))
    if input_data.get("streamResponse"):
        emit({"type": "headers", "status": status, "headers": headers})
        seq = 1
        while True:
            chunk = response.read(65536)
            if not chunk:
                break
            emit({
                "type": "bodyDelta",
                "seq": seq,
                "deltaBase64": base64.b64encode(chunk).decode("ascii"),
                "done": False,
            })
            seq += 1
        emit({"type": "bodyDelta", "seq": seq, "deltaBase64": "", "done": True})
        return
    body = response.read()
    emit({
        "status": status,
        "headers": headers,
        "bodyBase64": base64.b64encode(body).decode("ascii"),
    })

def main():
    input_data = json.load(sys.stdin)
    url = str(input_data.get("url", ""))
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError("http/request only supports http and https URLs")
    body_base64 = input_data.get("bodyBase64")
    data = base64.b64decode(body_base64) if isinstance(body_base64, str) else None
    request = urllib.request.Request(
        url,
        data=data,
        method=str(input_data.get("method", "GET")),
    )
    for header in input_data.get("headers") or []:
        request.add_header(str(header.get("name", "")), str(header.get("value", "")))
    timeout_ms = input_data.get("timeoutMs")
    timeout = None
    if isinstance(timeout_ms, (int, float)) and timeout_ms > 0:
        timeout = timeout_ms / 1000
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            handle_response(input_data, response)
    except urllib.error.HTTPError as response:
        handle_response(input_data, response)

if __name__ == "__main__":
    main()
PY
python3 "$tmp"
`.trim();

function sendHttpBodyDelta(
  socket: WebSocket,
  params: {
    requestId: string;
    seq: number;
    deltaBase64: string;
    done: boolean;
    error?: string | null;
  },
): void {
  if (socket.readyState !== 1) {
    return;
  }
  socket.send(
    JSON.stringify({
      jsonrpc: "2.0",
      method: "http/request/bodyDelta",
      params: {
        requestId: params.requestId,
        seq: params.seq,
        deltaBase64: params.deltaBase64,
        done: params.done,
        error: params.error ?? null,
      },
    }),
  );
}

async function readDirectory(
  execServer: OpenClawExecServer,
  params: JsonValue | undefined,
): Promise<JsonObject> {
  const record = requireObject(params, "fs/readDirectory params");
  const filePath = requireString(record.path, "path");
  const fsSandboxPolicy = resolveFsSandboxPolicy(execServer, record);
  return {
    entries: await listDirectoryEntries(execServer, filePath, fsSandboxPolicy),
  };
}

async function listDirectoryEntries(
  execServer: OpenClawExecServer,
  filePath: string,
  fsSandboxPolicy: ResolvedFsSandboxPolicy | undefined,
): Promise<DirectoryEntry[]> {
  assertResolvedFsSandboxAccess(fsSandboxPolicy, [{ path: filePath, access: "read" }]);
  const fsBridge = requireFsBridge(execServer);
  const backend = requireBackend(execServer);
  const resolved = fsBridge.resolvePath({
    filePath,
  });
  if (!resolved) {
    throw new Error(`Cannot resolve sandbox path: ${filePath}`);
  }
  const result = await backend.runShellCommand({
    script:
      'find "$1" -mindepth 1 -maxdepth 1 -exec sh -c \'for path do name=${path##*/}; if [ -L "$path" ]; then kind=o; elif [ -d "$path" ]; then kind=d; elif [ -f "$path" ]; then kind=f; else kind=o; fi; printf "%s\\t%s\\n" "$kind" "$name"; done\' sh {} +',
    args: [resolved.containerPath],
    allowFailure: true,
  });
  if (result.code !== 0) {
    const stderr = result.stderr.toString("utf8").trim();
    throw new Error(stderr || `sandbox directory listing failed with code ${result.code}`);
  }
  const lines = result.stdout.toString("utf8").split("\n").filter(Boolean);
  return lines.map((line) => {
    const [kind = "o", fileName = ""] = line.split("\t");
    return {
      fileName,
      isDirectory: kind === "d",
      isFile: kind === "f",
    };
  });
}

async function removePath(
  execServer: OpenClawExecServer,
  params: JsonValue | undefined,
): Promise<void> {
  const record = requireObject(params, "fs/remove params");
  const filePath = requireString(record.path, "path");
  const fsSandboxPolicy = resolveFsSandboxPolicy(execServer, record);
  assertResolvedFsSandboxAccess(fsSandboxPolicy, [{ path: filePath, access: "write" }]);
  if (record.recursive !== false) {
    assertNoReadOnlyDescendant(fsSandboxPolicy, filePath, "remove");
  }
  const fsBridge = requireFsBridge(execServer);
  await fsBridge.remove({
    filePath,
    recursive: record.recursive !== false,
    force: record.force !== false,
  });
}

async function copyPath(
  execServer: OpenClawExecServer,
  params: JsonValue | undefined,
): Promise<void> {
  const record = requireObject(params, "fs/copy params");
  const sourcePath = requireString(record.sourcePath ?? record.source, "sourcePath");
  const destinationPath = requireString(
    record.destinationPath ?? record.destination,
    "destinationPath",
  );
  const fsSandboxPolicy = resolveFsSandboxPolicy(execServer, record);
  assertResolvedFsSandboxAccess(fsSandboxPolicy, [
    { path: sourcePath, access: "read" },
    { path: destinationPath, access: "write" },
  ]);
  await copySandboxPath(execServer, {
    sourcePath,
    destinationPath,
    recursive: record.recursive === true,
    fsSandboxPolicy,
  });
}

async function copySandboxPath(
  execServer: OpenClawExecServer,
  params: {
    sourcePath: string;
    destinationPath: string;
    recursive: boolean;
    fsSandboxPolicy: ResolvedFsSandboxPolicy | undefined;
  },
): Promise<void> {
  const fsBridge = execServer.sandbox.fsBridge;
  if (!fsBridge) {
    throw new Error("Sandbox filesystem bridge is unavailable.");
  }
  assertResolvedFsSandboxAccess(params.fsSandboxPolicy, [
    { path: params.sourcePath, access: "read" },
    { path: params.destinationPath, access: "write" },
  ]);
  const sourceStat = await fsBridge.stat({ filePath: params.sourcePath });
  if (!sourceStat) {
    throw new JsonRpcProtocolError(JSON_RPC_NOT_FOUND, "file not found");
  }
  if (sourceStat?.type === "directory") {
    if (!params.recursive) {
      throw new Error(`Cannot copy directory without recursive=true: ${params.sourcePath}`);
    }
    if (
      pathContains(
        normalizeSandboxAbsolutePath(params.sourcePath, "copy source path"),
        normalizeSandboxAbsolutePath(params.destinationPath, "copy destination path"),
      )
    ) {
      throw new Error("Cannot recursively copy a directory into itself.");
    }
    await fsBridge.mkdirp({ filePath: params.destinationPath });
    for (const entry of await listDirectoryEntries(
      execServer,
      params.sourcePath,
      params.fsSandboxPolicy,
    )) {
      if (!entry.isDirectory && !entry.isFile) {
        throw new Error(`Cannot copy unsupported filesystem entry: ${entry.fileName}`);
      }
      await copySandboxPath(execServer, {
        sourcePath: joinSandboxChildPath(params.sourcePath, entry.fileName),
        destinationPath: joinSandboxChildPath(params.destinationPath, entry.fileName),
        recursive: true,
        fsSandboxPolicy: params.fsSandboxPolicy,
      });
    }
    return;
  }

  const data = await fsBridge.readFile({ filePath: params.sourcePath });
  await fsBridge.writeFile({
    filePath: params.destinationPath,
    data,
    mkdir: true,
  });
}

function assertFsSandboxAccess(
  execServer: OpenClawExecServer,
  record: JsonObject,
  requests: Array<{ path: string; access: "read" | "write" }>,
): void {
  assertResolvedFsSandboxAccess(resolveFsSandboxPolicy(execServer, record), requests);
}

function resolveFsSandboxPolicy(
  execServer: OpenClawExecServer,
  record: JsonObject,
): ResolvedFsSandboxPolicy | undefined {
  if (record.sandbox === undefined || record.sandbox === null) {
    return undefined;
  }
  const sandbox = requireObject(record.sandbox, "fs sandbox context");
  const permissions = requireObject(sandbox.permissions, "fs sandbox permissions");
  const permissionType = requireString(permissions.type, "fs sandbox permissions type");
  if (permissionType === "disabled" || permissionType === "external") {
    return { unrestricted: true, entries: [] };
  }
  if (permissionType !== "managed") {
    throw new Error(`Unsupported Codex fs sandbox permission type: ${permissionType}`);
  }

  const fileSystem = requireObject(permissions.file_system, "fs sandbox file system permissions");
  const fileSystemType = requireString(fileSystem.type, "fs sandbox file system permissions type");
  if (fileSystemType === "unrestricted") {
    return { unrestricted: true, entries: [] };
  }
  if (fileSystemType !== "restricted") {
    throw new Error(`Unsupported Codex fs sandbox file system type: ${fileSystemType}`);
  }
  if (!Array.isArray(fileSystem.entries)) {
    throw new Error("fs sandbox file system entries must be an array.");
  }
  const cwd = readFsSandboxCwd(execServer, sandbox);
  return {
    unrestricted: false,
    entries: fileSystem.entries.flatMap((entry, index) => {
      const resolved = resolveFsSandboxEntry(
        requireObject(entry, `fs sandbox entry ${index}`),
        cwd,
      );
      return resolved ? [resolved] : [];
    }),
  };
}

function readFsSandboxCwd(execServer: OpenClawExecServer, sandbox: JsonObject): string {
  if (sandbox.cwd === undefined || sandbox.cwd === null) {
    return normalizeSandboxAbsolutePath(execServer.sandbox.containerWorkdir, "sandbox cwd");
  }
  return normalizeSandboxAbsolutePath(requireString(sandbox.cwd, "sandbox cwd"), "sandbox cwd");
}

function resolveFsSandboxEntry(entry: JsonObject, cwd: string): ResolvedFsSandboxEntry | undefined {
  const access = readFsAccessMode(entry.access);
  const pathSpec = requireObject(entry.path, "fs sandbox entry path");
  const pathType = requireString(pathSpec.type, "fs sandbox entry path type");
  if (pathType === "path") {
    return {
      kind: "path",
      path: normalizeSandboxAbsolutePath(
        requireString(pathSpec.path, "fs sandbox path"),
        "fs sandbox path",
      ),
      access,
    };
  }
  if (pathType === "special") {
    if (isNonGrantingFsSpecialPath(requireObject(pathSpec.value, "fs sandbox special path"))) {
      return undefined;
    }
    return {
      kind: "path",
      path: resolveFsSpecialPath(requireObject(pathSpec.value, "fs sandbox special path"), cwd),
      access,
    };
  }
  if (pathType === "glob_pattern") {
    const pattern = requireString(pathSpec.pattern, "fs sandbox glob pattern");
    const absolutePattern = normalizeSandboxGlobPattern(
      pattern.startsWith("/") ? pattern : pathPosix.join(cwd, pattern),
    );
    return {
      kind: "glob",
      pattern: absolutePattern,
      matcher: compileSandboxGlobPattern(absolutePattern),
      literalPrefix: sandboxGlobLiteralPrefix(absolutePattern),
      access,
    };
  }
  throw new Error(`Unsupported Codex fs sandbox path type: ${pathType}`);
}

function isNonGrantingFsSpecialPath(value: JsonObject): boolean {
  const kind = requireString(value.kind, "fs sandbox special path kind");
  return kind === "minimal" || kind === "unknown";
}

function readFsAccessMode(value: unknown): FsAccessMode {
  if (value === "read" || value === "write" || value === "none") {
    return value;
  }
  if (value === "deny") {
    return "none";
  }
  throw new Error("fs sandbox entry access must be read, write, none, or deny.");
}

function resolveFsSpecialPath(value: JsonObject, cwd: string): string {
  const kind = requireString(value.kind, "fs sandbox special path kind");
  if (kind === "root") {
    return "/";
  }
  if (kind === "project_roots" || kind === "current_working_directory") {
    const subpath =
      value.subpath === undefined || value.subpath === null
        ? undefined
        : requireString(value.subpath, "fs sandbox project roots subpath");
    return normalizeSandboxAbsolutePath(
      subpath ? pathPosix.join(cwd, subpath) : cwd,
      "fs sandbox project roots path",
    );
  }
  if (kind === "slash_tmp" || kind === "tmpdir") {
    return "/tmp";
  }
  throw new Error(`Unsupported Codex fs sandbox special path: ${kind}`);
}

function assertResolvedFsSandboxAccess(
  policy: ResolvedFsSandboxPolicy | undefined,
  requests: Array<{ path: string; access: "read" | "write" }>,
): void {
  if (!policy?.unrestricted && policy) {
    for (const request of requests) {
      const access = resolveFsAccess(policy, request.path);
      if (request.access === "read" && access === "none") {
        throw new Error(`Codex fs sandbox denied read access to ${request.path}`);
      }
      if (request.access === "write" && access !== "write") {
        throw new Error(`Codex fs sandbox denied write access to ${request.path}`);
      }
    }
  }
}

function resolveFsAccess(policy: ResolvedFsSandboxPolicy, rawPath: string): FsAccessMode {
  if (policy.unrestricted) {
    return "write";
  }
  const target = normalizeSandboxAbsolutePath(rawPath, "fs path");
  let selected: { specificity: number; rank: number; access: FsAccessMode } | undefined;
  for (const entry of policy.entries) {
    if (!fsSandboxEntryMatches(entry, target)) {
      continue;
    }
    const candidate = {
      specificity: fsSandboxEntrySpecificity(entry),
      rank: fsAccessRank(entry.access),
      access: entry.access,
    };
    if (
      !selected ||
      candidate.specificity > selected.specificity ||
      (candidate.specificity === selected.specificity && candidate.rank > selected.rank)
    ) {
      selected = candidate;
    }
  }
  return selected?.access ?? "none";
}

function assertNoReadOnlyDescendant(
  policy: ResolvedFsSandboxPolicy | undefined,
  rawPath: string,
  operation: string,
): void {
  if (!policy || policy.unrestricted) {
    return;
  }
  const target = normalizeSandboxAbsolutePath(rawPath, "fs path");
  const protectedDescendant = policy.entries.find((entry) => {
    if (entry.access === "write" || !fsSandboxEntryCanAffectDescendant(entry, target)) {
      return false;
    }
    if (entry.kind === "glob") {
      return true;
    }
    const protectedPath = entry.path;
    return protectedPath && resolveFsAccess(policy, protectedPath) !== "write";
  });
  if (protectedDescendant) {
    const protectedPath =
      protectedDescendant.kind === "path" ? protectedDescendant.path : protectedDescendant.pattern;
    throw new Error(
      `Codex fs sandbox denied recursive ${operation} of ${rawPath} because ${protectedPath} is not writable.`,
    );
  }
}

function normalizeSandboxAbsolutePath(rawPath: string, label: string): string {
  if (!rawPath || rawPath.includes("\0") || !rawPath.startsWith("/")) {
    throw new Error(`${label} must be an absolute sandbox path.`);
  }
  const normalized = pathPosix.normalize(rawPath);
  return normalized === "//" ? "/" : normalized;
}

function pathContains(root: string, target: string): boolean {
  return root === "/" || target === root || target.startsWith(`${root}/`);
}

function fsSandboxEntryMatches(entry: ResolvedFsSandboxEntry, target: string): boolean {
  if (entry.kind === "path") {
    return pathContains(entry.path, target);
  }
  return entry.matcher.test(target);
}

function fsSandboxEntryCanAffectDescendant(entry: ResolvedFsSandboxEntry, target: string): boolean {
  if (entry.kind === "path") {
    return pathContains(target, entry.path) && target !== entry.path;
  }
  return pathContains(target, entry.literalPrefix) || pathContains(entry.literalPrefix, target);
}

function fsSandboxEntrySpecificity(entry: ResolvedFsSandboxEntry): number {
  return pathSpecificity(entry.kind === "path" ? entry.path : entry.literalPrefix);
}

function pathSpecificity(filePath: string): number {
  return filePath === "/" ? 0 : filePath.split("/").filter(Boolean).length;
}

function fsAccessRank(access: FsAccessMode): number {
  if (access === "none") {
    return 2;
  }
  if (access === "write") {
    return 1;
  }
  return 0;
}

function normalizeSandboxGlobPattern(pattern: string): string {
  if (!pattern || pattern.includes("\0") || !pattern.startsWith("/")) {
    throw new Error("fs sandbox glob pattern must be absolute.");
  }
  return pattern.replace(/\/{2,}/gu, "/");
}

function compileSandboxGlobPattern(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    if (char === "*" && next === "*" && pattern[index + 2] === "/") {
      source += "(?:.*/)?";
      index += 2;
    } else if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "[") {
      const compiledClass = compileSandboxGlobCharacterClass(pattern, index);
      source += compiledClass.source;
      index = compiledClass.endIndex;
    } else {
      source += char?.replace(/[\\^$+?.()|[\]{}]/gu, "\\$&") ?? "";
    }
  }
  source += "$";
  return new RegExp(source, "u");
}

function compileSandboxGlobCharacterClass(
  pattern: string,
  startIndex: number,
): { source: string; endIndex: number } {
  let index = startIndex + 1;
  if (index >= pattern.length) {
    throw new Error("fs sandbox glob character class must be closed.");
  }
  const negated = pattern[index] === "!" || pattern[index] === "^";
  if (negated) {
    index += 1;
  }
  let body = "";
  for (; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "]" && body) {
      return {
        source: `[${negated ? "^" : ""}${body}]`,
        endIndex: index,
      };
    }
    if (!char || char === "/") {
      throw new Error("fs sandbox glob character class cannot match path separators.");
    }
    body += escapeSandboxGlobCharacterClassChar(char, body.length === 0);
  }
  throw new Error("fs sandbox glob character class must be closed.");
}

function escapeSandboxGlobCharacterClassChar(char: string, first: boolean): string {
  if (char === "\\" || char === "]") {
    return `\\${char}`;
  }
  if (first && char === "^") {
    return "\\^";
  }
  return char;
}

function sandboxGlobLiteralPrefix(pattern: string): string {
  const wildcardIndex = pattern.search(/[*?[]/u);
  const prefix = wildcardIndex === -1 ? pattern : pattern.slice(0, wildcardIndex);
  const slash = prefix.lastIndexOf("/");
  if (slash <= 0) {
    return "/";
  }
  return normalizeSandboxAbsolutePath(prefix.slice(0, slash), "fs sandbox glob prefix");
}

function requireBackend(execServer: OpenClawExecServer): NonNullable<SandboxContext["backend"]> {
  const backend = execServer.sandbox.backend;
  if (!backend) {
    throw new Error("OpenClaw sandbox backend is unavailable.");
  }
  return backend;
}

function requireFsBridge(execServer: OpenClawExecServer): NonNullable<SandboxContext["fsBridge"]> {
  const fsBridge = execServer.sandbox.fsBridge;
  if (!fsBridge) {
    throw new Error("Sandbox filesystem bridge is unavailable.");
  }
  return fsBridge;
}

function joinSandboxChildPath(parent: string, child: string): string {
  if (!child || child === "." || child === ".." || child.includes("/") || child.includes("\0")) {
    throw new Error(`Invalid sandbox directory entry name: ${child}`);
  }
  return parent.endsWith("/") ? `${parent}${child}` : `${parent}/${child}`;
}

function metadataResponse(stat: SandboxFsStat | null): JsonObject {
  return {
    isDirectory: stat?.type === "directory",
    isFile: stat?.type === "file",
    isSymlink: false,
    createdAtMs: 0,
    modifiedAtMs: stat?.mtimeMs ?? 0,
  };
}

function waitForProcessUpdate(managed: ManagedProcess, waitMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, Math.min(waitMs, 30_000));
    function done() {
      clearTimeout(timer);
      managed.waiters = managed.waiters.filter((waiter) => waiter !== done);
      resolve();
    }
    managed.waiters.push(done);
  });
}

function notifyProcessWaiters(managed: ManagedProcess): void {
  const waiters = managed.waiters;
  managed.waiters = [];
  for (const waiter of waiters) {
    waiter();
  }
}

function hasChunksAtOrAfter(managed: ManagedProcess, afterSeq: number): boolean {
  return managed.chunks.some((chunk) => chunk.seq > afterSeq);
}

function shellCommandFromArgv(argv: string[]): string {
  return argv.map(shellEscape).join(" ");
}

function shellEscape(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function requireProcess(processes: Map<string, ManagedProcess>, processId: string): ManagedProcess {
  const managed = processes.get(processId);
  if (!managed) {
    throw new Error(`unknown process: ${processId}`);
  }
  return managed;
}

function parseRequest(data: RawData): JsonRpcRequest {
  const buffer = Array.isArray(data)
    ? Buffer.concat(data)
    : Buffer.isBuffer(data)
      ? data
      : Buffer.from(data);
  const text = buffer.toString("utf8");
  const parsed = JSON.parse(text) as unknown;
  return requireObject(parsed, "JSON-RPC request") as JsonRpcRequest;
}

function requireObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as JsonObject;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function requireBase64String(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  return value;
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number.`);
  }
  return value;
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be a string array.`);
  }
  if (value.length === 0) {
    throw new Error(`${label} must not be empty.`);
  }
  return value;
}

function rejectUnsupportedArg0(value: unknown): void {
  if (value === undefined || value === null) {
    return;
  }
  if (typeof value === "string") {
    throw new Error("Codex sandbox exec-server does not support arg0 overrides.");
  }
  throw new Error("arg0 must be a string or null.");
}

function readEnv(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const env: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (typeof rawValue === "string" && ENV_KEY_RE.test(key)) {
      env[key] = rawValue;
    }
  }
  return env;
}

function readProcessEnv(record: JsonObject): Record<string, string> {
  const policyEnv = buildEnvFromPolicy(record.envPolicy);
  return {
    ...policyEnv,
    ...readEnv(record.env),
  };
}

function buildEnvFromPolicy(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const policy = value as Record<string, unknown>;
  const inheritedEnv = readEnv(policy.set);
  const includeOnly = readStringList(policy.includeOnly);
  if (includeOnly.length > 0) {
    filterEnvKeys(inheritedEnv, includeOnly, true);
  }
  return inheritedEnv;
}

function filterEnvKeys(
  env: Record<string, string>,
  patterns: string[],
  keepMatches: boolean,
): void {
  if (patterns.length === 0) {
    return;
  }
  const regexes = patterns.map((pattern) => wildcardPatternToRegex(pattern));
  for (const key of Object.keys(env)) {
    const matches = regexes.some((regex) => regex.test(key));
    if (matches !== keepMatches) {
      delete env[key];
    }
  }
}

function wildcardPatternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^${escaped.replaceAll("*", ".*").replaceAll("?", ".")}$`, "iu");
}

function readStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function readHttpHeaders(value: unknown): HttpHeader[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry, index) => {
    const record = requireObject(entry as JsonValue, `header ${index}`);
    return {
      name: requireString(record.name, "header name"),
      value: requireString(record.value, "header value"),
    };
  });
}

function sendResult(socket: WebSocket, id: string | number, result: JsonValue | undefined): void {
  socket.send(JSON.stringify({ jsonrpc: "2.0", id, result: result ?? {} }));
}

function sendError(
  socket: WebSocket,
  id: string | number | undefined,
  code: number,
  message: string,
): void {
  socket.send(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }));
}
