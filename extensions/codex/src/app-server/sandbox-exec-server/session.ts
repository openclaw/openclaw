/** Owns the JSON-RPC protocol and resources of one sandbox execution connection. */
import { randomUUID } from "node:crypto";
import { posix as pathPosix } from "node:path";
import { pathToFileURL } from "node:url";
import type { SandboxFsStat } from "openclaw/plugin-sdk/sandbox";
import type { CodexNativeProcessClient } from "../native-process-authority.js";
import type { JsonValue, JsonObject } from "../protocol.js";
import {
  assertNoReadOnlyDescendant,
  assertResolvedFsSandboxAccess,
  joinSandboxChildPath,
  normalizeSandboxAbsolutePath,
  pathContains,
  resolveFsSandboxPolicy,
} from "./fs-policy.js";
import { httpRequest } from "./http.js";
import {
  JSON_RPC_METHOD_NOT_FOUND,
  JsonRpcProtocolError,
  sendError,
  sendResult,
  JSON_RPC_NOT_FOUND,
  requireNumber,
  requireObject,
  requireString,
} from "./json-rpc.js";
import { resolveExecServerPath } from "./path-uri.js";
import {
  readProcess,
  signalProcess,
  startProcess,
  terminateProcess,
  writeProcess,
} from "./processes.js";
import type {
  CodexSandboxExecMessageTransport,
  CodexSandboxExecSessionNotifications,
  JsonRpcRequest,
  ManagedProcess,
  OpenClawExecServer,
  DirectoryEntry,
  ResolvedFsSandboxPolicy,
} from "./types.js";

const CODEX_SANDBOX_EXEC_SERVER_MAX_READ_FILE_BYTES = 512 * 1024 * 1024;
const CODEX_SANDBOX_EXEC_SERVER_MAX_OPEN_FILE_READS = 128;
const CODEX_SANDBOX_EXEC_SERVER_MAX_BUFFERED_FILE_READ_BYTES = 64 * 1024 * 1024;
const CODEX_SANDBOX_EXEC_SERVER_MAX_READ_BLOCK_BYTES = 1024 * 1024;
const CODEX_SANDBOX_EXEC_SERVER_MAX_FILE_READ_HANDLE_ID_BYTES = 32;

type CodexSandboxFileReadHandle = {
  abortController: AbortController;
  closeRequested: boolean;
  reservedBytes: number;
  data?: Buffer;
};

/** Sandboxed file contents and pending reservations owned by one connection. */
type CodexSandboxFileReadHandles = Map<string, CodexSandboxFileReadHandle> & {
  closed?: boolean;
};

function requireFileReadHandleId(value: unknown): string {
  const handleId = requireString(value, "handleId");
  if (
    Buffer.byteLength(handleId, "utf8") > CODEX_SANDBOX_EXEC_SERVER_MAX_FILE_READ_HANDLE_ID_BYTES
  ) {
    throw new JsonRpcProtocolError(
      -32600,
      `file read handle ID must not exceed ${CODEX_SANDBOX_EXEC_SERVER_MAX_FILE_READ_HANDLE_ID_BYTES} bytes`,
    );
  }
  return handleId;
}

function decodeFileData(value: unknown): Buffer {
  if (typeof value !== "string") {
    throw new Error("dataBase64 must be a string.");
  }
  return Buffer.from(value, "base64");
}

async function authorizePhysicalReadPath(
  fsBridge: OpenClawExecServer["fsBridge"],
  policy: ResolvedFsSandboxPolicy | undefined,
  filePath: string,
  signal?: AbortSignal,
): Promise<{ expectedPolicyPath?: string }> {
  if (!policy || policy.unrestricted || !fsBridge.resolveReadPolicyPath) {
    return {};
  }
  const expectedPolicyPath = await fsBridge.resolveReadPolicyPath({ filePath, signal });
  assertResolvedFsSandboxAccess(policy, [{ path: expectedPolicyPath, access: "read" }]);
  return { expectedPolicyPath };
}

function assertSandboxFileReadWithinLimit(stat: SandboxFsStat): void {
  if (stat.type === "file" && stat.size > CODEX_SANDBOX_EXEC_SERVER_MAX_READ_FILE_BYTES) {
    throw new Error(
      `file is too large to read through Codex sandbox exec-server: ${stat.size} bytes`,
    );
  }
}

/** Connection-local execution state; closing it never enables session resumption. */
export class CodexSandboxExecSession {
  private readonly processes = new Map<string, ManagedProcess>();
  private readonly fileReads: CodexSandboxFileReadHandles = new Map();
  private readonly httpRequests = new Set<Promise<void>>();
  private readonly closeController = new AbortController();
  private readonly notifications: CodexSandboxExecSessionNotifications;
  private cleanup?: Promise<void>;

  constructor(
    private readonly execServer: OpenClawExecServer,
    private readonly transport: CodexSandboxExecMessageTransport,
    private readonly processAuthority?: CodexNativeProcessClient,
  ) {
    this.notifications = {
      signal: this.closeController.signal,
      send: (method, params) => {
        if (transport.isOpen()) {
          transport.send({ jsonrpc: "2.0", method, params });
        }
      },
    };
  }

  async handleRequest(request: JsonRpcRequest): Promise<void> {
    const method = request.method;
    if (!method) {
      sendError(this.transport.send, request.id, -32600, "Invalid Request");
      return;
    }
    if (request.id === undefined) {
      if (method !== "initialized") {
        sendError(this.transport.send, -1, -32600, `Unexpected notification: ${method}`);
      }
      return;
    }
    try {
      const result = await this.dispatchRequest(method, request.params);
      sendResult(this.transport.send, request.id, result);
    } catch (error) {
      sendError(
        this.transport.send,
        request.id,
        error instanceof JsonRpcProtocolError ? error.code : -32603,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  close(): Promise<void> {
    if (!this.cleanup) {
      // Abort streamed HTTP and file reservations before reaping connection-owned processes.
      this.closeController.abort();
      this.closeAllFileReads();
      this.cleanup = Promise.allSettled([
        ...this.httpRequests,
        ...[...this.processes.keys()].map(async (processId) =>
          terminateProcess(this.processes, { processId }),
        ),
      ]).then((results) => {
        const failures = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length > 0) {
          throw new AggregateError(failures, "Codex sandbox execution cleanup failed");
        }
      });
    }
    return this.cleanup;
  }

  private async dispatchRequest(method: string, params?: JsonValue): Promise<JsonValue> {
    switch (method) {
      case "initialize":
        return { sessionId: randomUUID() };
      case "environment/info":
        // Shell and cwd describe the sandbox target, never the Gateway host.
        return {
          shell: { name: "sh", path: "/bin/sh" },
          cwd: pathToFileURL(this.execServer.sandbox.containerWorkdir, { windows: false }).href,
          capabilities: { networkProxyLaunch: false },
        };
      case "environment/status":
        return { status: "ready" };
      // Registered exec-server URLs use these process methods, not app-server process/spawn.
      case "process/start":
        return startProcess(
          this.execServer,
          this.processes,
          this.notifications.send,
          params,
          this.processAuthority,
        );
      case "process/read":
        return await readProcess(this.processes, params);
      case "process/write":
        return writeProcess(this.processes, params);
      case "process/signal":
        return await signalProcess(this.processes, params);
      case "process/terminate":
        return await terminateProcess(this.processes, params);
      case "fs/open":
        return await this.openFile(params);
      case "fs/readBlock":
        return this.readFileBlock(params);
      case "fs/close":
        return this.closeFile(params);
      case "fs/readFile":
      case "fs/getMetadata":
        return await this.readFileOrMetadata(params, method);
      case "fs/writeFile":
      case "fs/createDirectory":
        await this.writeFileOrDirectory(params, method);
        return {};
      case "fs/readDirectory":
        return await this.readDirectory(params);
      case "fs/remove":
        await this.removePath(params);
        return {};
      case "fs/copy":
        await this.copyPath(params);
        return {};
      case "http/request":
        return await httpRequest(this.execServer, this.notifications, params, this.httpRequests);
      default:
        throw new JsonRpcProtocolError(
          JSON_RPC_METHOD_NOT_FOUND,
          `Unsupported OpenClaw sandbox exec-server method: ${method}`,
        );
    }
  }

  /** Opens a policy-checked sandbox file under a bounded, connection-owned handle. */
  private async openFile(params: JsonValue | undefined): Promise<JsonObject> {
    const record = requireObject(params, "fs/open params");
    const handleId = requireFileReadHandleId(record.handleId);
    if (this.fileReads.closed) {
      throw new JsonRpcProtocolError(
        JSON_RPC_NOT_FOUND,
        `unknown file read handle \`${handleId}\``,
      );
    }
    if (this.fileReads.has(handleId)) {
      throw new JsonRpcProtocolError(-32600, `file read handle \`${handleId}\` already exists`);
    }
    if (this.fileReads.size >= CODEX_SANDBOX_EXEC_SERVER_MAX_OPEN_FILE_READS) {
      throw new JsonRpcProtocolError(
        -32600,
        `at most ${CODEX_SANDBOX_EXEC_SERVER_MAX_OPEN_FILE_READS} file reads may be open per connection`,
      );
    }

    const filePath = resolveExecServerPath(requireString(record.path, "path"), "read path");
    const fsSandboxPolicy = resolveFsSandboxPolicy(this.execServer, record);
    assertResolvedFsSandboxAccess(fsSandboxPolicy, [{ path: filePath, access: "read" }]);
    const fsBridge = this.execServer.fsBridge;
    // Claim the handle before even stat so slow or cancelled stats cannot bypass
    // the connection's handle cap or lose their cancellation and ownership.
    const handle: CodexSandboxFileReadHandle = {
      abortController: new AbortController(),
      closeRequested: false,
      reservedBytes: 0,
    };
    this.fileReads.set(handleId, handle);
    const assertCurrent = () => {
      if (
        this.fileReads.get(handleId) !== handle ||
        handle.closeRequested ||
        this.fileReads.closed
      ) {
        throw new JsonRpcProtocolError(
          JSON_RPC_NOT_FOUND,
          `unknown file read handle \`${handleId}\``,
        );
      }
    };
    try {
      const readPolicy = await authorizePhysicalReadPath(
        fsBridge,
        fsSandboxPolicy,
        filePath,
        handle.abortController.signal,
      );
      const stat = await fsBridge.stat({
        filePath,
        signal: handle.abortController.signal,
        ...readPolicy,
      });
      assertCurrent();
      if (!stat) {
        throw new JsonRpcProtocolError(JSON_RPC_NOT_FOUND, "file not found");
      }
      if (stat.type !== "file") {
        throw new JsonRpcProtocolError(-32600, "file read handle requires a regular file");
      }
      if (!Number.isSafeInteger(stat.size) || stat.size < 0) {
        throw new JsonRpcProtocolError(-32600, "file size must be a non-negative safe integer");
      }
      if (
        stat.size >
        CODEX_SANDBOX_EXEC_SERVER_MAX_BUFFERED_FILE_READ_BYTES - this.bufferedFileReadBytes()
      ) {
        throw new JsonRpcProtocolError(
          -32600,
          "sandbox file read exceeds the per-connection buffered file limit",
        );
      }
      // Charge actual bytes before awaiting the bounded read; concurrent stats
      // cannot overbook memory, even when a backend ignores cancellation.
      handle.reservedBytes = stat.size;
      const data = await fsBridge.readFile({
        filePath,
        maxBytes: handle.reservedBytes,
        signal: handle.abortController.signal,
        ...readPolicy,
      });
      assertCurrent();
      if (data.byteLength > handle.reservedBytes) {
        throw new JsonRpcProtocolError(
          -32600,
          "sandbox file read exceeds the per-connection buffered file limit",
        );
      }
      handle.reservedBytes = data.byteLength;
      handle.data = data;
      return { handleId };
    } catch (error) {
      if (this.fileReads.get(handleId) === handle) {
        this.fileReads.delete(handleId);
      }
      throw error;
    }
  }

  /** Reads a bounded base64 block from a handle belonging to this connection. */
  private readFileBlock(params: JsonValue | undefined): JsonObject {
    const record = requireObject(params, "fs/readBlock params");
    const handleId = requireFileReadHandleId(record.handleId);
    const handle = this.fileReads.get(handleId);
    if (!handle?.data) {
      throw new JsonRpcProtocolError(
        JSON_RPC_NOT_FOUND,
        `unknown file read handle \`${handleId}\``,
      );
    }
    const offset = requireNumber(record.offset, "offset");
    const length = requireNumber(record.len, "len");
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new JsonRpcProtocolError(
        -32600,
        "file read offset must be a non-negative safe integer",
      );
    }
    if (
      !Number.isSafeInteger(length) ||
      length < 1 ||
      length > CODEX_SANDBOX_EXEC_SERVER_MAX_READ_BLOCK_BYTES
    ) {
      throw new JsonRpcProtocolError(
        -32600,
        `file read block length must be between 1 and ${CODEX_SANDBOX_EXEC_SERVER_MAX_READ_BLOCK_BYTES}`,
      );
    }
    const chunk = handle.data.subarray(offset, Math.min(offset + length, handle.data.byteLength));
    // The complete buffered file makes exactly filled final blocks terminal without another RPC.
    return {
      chunk: chunk.toString("base64"),
      eof: offset + chunk.byteLength >= handle.data.byteLength,
    };
  }

  /** Closes one connection-owned file handle; repeated closes are harmless. */
  private closeFile(params: JsonValue | undefined): JsonObject {
    const record = requireObject(params, "fs/close params");
    this.closeFileReadHandle(requireFileReadHandleId(record.handleId));
    return {};
  }

  /** Cancels a disconnected socket without releasing unsettled read reservations. */
  private closeAllFileReads(): void {
    this.fileReads.closed = true;
    for (const handleId of this.fileReads.keys()) {
      this.closeFileReadHandle(handleId);
    }
  }

  private closeFileReadHandle(handleId: string): void {
    const handle = this.fileReads.get(handleId);
    if (!handle) {
      return;
    }
    handle.closeRequested = true;
    if (handle.data !== undefined) {
      this.fileReads.delete(handleId);
      return;
    }
    // A backend may not honor abort; retain its reservation until readFile settles.
    handle.abortController.abort();
  }

  private bufferedFileReadBytes(): number {
    let total = 0;
    for (const handle of this.fileReads.values()) {
      total += handle.reservedBytes;
    }
    return total;
  }

  private async readFileOrMetadata(
    params: JsonValue | undefined,
    method: "fs/readFile" | "fs/getMetadata",
  ): Promise<JsonObject> {
    const record = requireObject(params, `${method} params`);
    const metadataOnly = method === "fs/getMetadata";
    const filePath = resolveExecServerPath(
      requireString(record.path, "path"),
      metadataOnly ? "metadata path" : "read path",
    );
    const fsSandboxPolicy = resolveFsSandboxPolicy(this.execServer, record);
    assertResolvedFsSandboxAccess(fsSandboxPolicy, [{ path: filePath, access: "read" }]);
    const fsBridge = this.execServer.fsBridge;
    const readPolicy = await authorizePhysicalReadPath(fsBridge, fsSandboxPolicy, filePath);
    // Content reads retain their bridge; metadata reads observe the current bridge after authorization.
    const stat = await (metadataOnly ? this.execServer.fsBridge : fsBridge).stat({
      filePath,
      ...readPolicy,
    });
    if (!stat) {
      throw new JsonRpcProtocolError(JSON_RPC_NOT_FOUND, "file not found");
    }
    if (metadataOnly) {
      return {
        isDirectory: stat.type === "directory",
        isFile: stat.type === "file",
        isSymlink: false,
        size: stat.size,
        createdAtMs: 0,
        modifiedAtMs: stat.mtimeMs ?? 0,
      };
    }
    assertSandboxFileReadWithinLimit(stat);
    const data = await fsBridge.readFile({
      filePath,
      maxBytes: CODEX_SANDBOX_EXEC_SERVER_MAX_READ_FILE_BYTES,
      ...readPolicy,
    });
    return { dataBase64: data.toString("base64") };
  }

  private async writeFileOrDirectory(
    params: JsonValue | undefined,
    method: "fs/writeFile" | "fs/createDirectory",
  ): Promise<void> {
    const record = requireObject(params, `${method} params`);
    const directory = method === "fs/createDirectory";
    const filePath = resolveExecServerPath(
      requireString(record.path, "path"),
      directory ? "create-directory path" : "write path",
    );
    const fsBridge = this.execServer.fsBridge;
    // Authorize the canonical destination before pinning the mutation so a
    // symlinked parent cannot redirect an approved write into a protected path.
    const canonicalDestination = await fsBridge.resolvePinnedMutationTarget?.({
      filePath,
      action: directory ? "mkdir" : "write",
    });
    assertResolvedFsSandboxAccess(resolveFsSandboxPolicy(this.execServer, record), [
      { path: filePath, access: "write" },
      ...(canonicalDestination
        ? [{ path: canonicalDestination.policyPath, access: "write" as const }]
        : []),
    ]);
    if (!directory || record.recursive === false) {
      const parent = await fsBridge.stat({ filePath: pathPosix.dirname(filePath) });
      if (parent?.type !== "directory") {
        throw new JsonRpcProtocolError(JSON_RPC_NOT_FOUND, "parent directory not found");
      }
    }
    if (directory) {
      await fsBridge.mkdirp({ filePath, pinnedPath: canonicalDestination?.pinnedPath });
    } else {
      await fsBridge.writeFile({
        filePath,
        data: decodeFileData(record.dataBase64),
        mkdir: false,
        pinnedPath: canonicalDestination?.pinnedPath,
      });
    }
  }

  private async readDirectory(params: JsonValue | undefined): Promise<JsonObject> {
    const record = requireObject(params, "fs/readDirectory params");
    const filePath = resolveExecServerPath(
      requireString(record.path, "path"),
      "read-directory path",
    );
    const fsSandboxPolicy = resolveFsSandboxPolicy(this.execServer, record);
    return {
      entries: await this.listDirectoryEntries(filePath, fsSandboxPolicy),
    };
  }

  private async listDirectoryEntries(
    filePath: string,
    fsSandboxPolicy: ResolvedFsSandboxPolicy | undefined,
  ): Promise<DirectoryEntry[]> {
    assertResolvedFsSandboxAccess(fsSandboxPolicy, [{ path: filePath, access: "read" }]);
    const resolved = this.execServer.fsBridge.resolvePath({
      filePath,
    });
    if (!resolved) {
      throw new Error(`Cannot resolve sandbox path: ${filePath}`);
    }
    const result = await this.execServer.backend.runShellCommand({
      script:
        'find "$1" -mindepth 1 -maxdepth 1 -exec sh -c \'for path do name=${path##*/}; if [ -L "$path" ]; then kind=o; elif [ -d "$path" ]; then kind=d; elif [ -f "$path" ]; then kind=f; else kind=o; fi; printf "%s%s\\000" "$kind" "$name"; done\' sh {} +',
      args: [resolved.containerPath],
      allowFailure: true,
    });
    if (result.code !== 0) {
      const stderr = result.stderr.toString("utf8").trim();
      throw new Error(stderr || `sandbox directory listing failed with code ${result.code}`);
    }
    // POSIX basenames can contain tabs and newlines, but never a NUL byte.
    return result.stdout
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .map((entry) => ({
        fileName: entry.slice(1),
        isDirectory: entry[0] === "d",
        isFile: entry[0] === "f",
      }));
  }

  private async removePath(params: JsonValue | undefined): Promise<void> {
    const record = requireObject(params, "fs/remove params");
    const filePath = resolveExecServerPath(requireString(record.path, "path"), "remove path");
    const fsSandboxPolicy = resolveFsSandboxPolicy(this.execServer, record);
    const canonicalDestination = await this.execServer.fsBridge.resolvePinnedMutationTarget?.({
      filePath,
      action: "remove",
    });
    assertResolvedFsSandboxAccess(fsSandboxPolicy, [
      { path: filePath, access: "write" },
      ...(canonicalDestination
        ? [{ path: canonicalDestination.policyPath, access: "write" as const }]
        : []),
    ]);
    if (record.recursive !== false) {
      assertNoReadOnlyDescendant(fsSandboxPolicy, filePath, "remove");
      if (canonicalDestination) {
        assertNoReadOnlyDescendant(fsSandboxPolicy, canonicalDestination.policyPath, "remove");
      }
    }
    await this.execServer.fsBridge.remove({
      filePath,
      recursive: record.recursive !== false,
      force: record.force !== false,
      pinnedPath: canonicalDestination?.pinnedPath,
    });
  }

  private async copyPath(params: JsonValue | undefined): Promise<void> {
    const record = requireObject(params, "fs/copy params");
    const sourcePath = resolveExecServerPath(
      requireString(record.sourcePath ?? record.source, "sourcePath"),
      "copy source path",
    );
    const destinationPath = resolveExecServerPath(
      requireString(record.destinationPath ?? record.destination, "destinationPath"),
      "copy destination path",
    );
    const fsSandboxPolicy = resolveFsSandboxPolicy(this.execServer, record);
    await this.copySandboxPath({
      sourcePath,
      destinationPath,
      recursive: record.recursive === true,
      fsSandboxPolicy,
    });
  }

  private async copySandboxPath(params: {
    sourcePath: string;
    destinationPath: string;
    recursive: boolean;
    fsSandboxPolicy: ResolvedFsSandboxPolicy | undefined;
  }): Promise<void> {
    const fsBridge = this.execServer.fsBridge;
    // Lexical policy checks run before any filesystem access so denied sources
    // and destinations fail without side effects.
    assertResolvedFsSandboxAccess(params.fsSandboxPolicy, [
      { path: params.sourcePath, access: "read" },
      { path: params.destinationPath, access: "write" },
    ]);
    const sourceStat = await fsBridge.stat({ filePath: params.sourcePath });
    if (!sourceStat) {
      throw new JsonRpcProtocolError(JSON_RPC_NOT_FOUND, "file not found");
    }
    // Authorize the canonical copy destination before pinning the mutation so a
    // symlinked parent cannot redirect an approved copy into a protected path.
    // Recursive directory copies authorize the destination directory itself (an
    // alias may rename it and an existing mount root stays valid); file copies
    // authorize the canonical parent plus the requested basename.
    const canonicalDestination = await fsBridge.resolvePinnedMutationTarget?.({
      filePath: params.destinationPath,
      action: sourceStat.type === "directory" ? "mkdir" : "copy-destination",
    });
    const canonicalPolicyEntries = canonicalDestination
      ? [{ path: canonicalDestination.policyPath, access: "write" as const }]
      : [];
    assertResolvedFsSandboxAccess(params.fsSandboxPolicy, canonicalPolicyEntries);
    if (sourceStat.type === "directory") {
      if (!params.recursive) {
        throw new Error(`Cannot copy directory without recursive=true: ${params.sourcePath}`);
      }
      // Directory target resolution is side-effect free, so use the same
      // canonical directory view for the source containment check. Comparing
      // only lexical paths lets an alias hide that the destination is inside
      // the source and can make recursive copy enumerate its own output.
      const canonicalSource = await fsBridge.resolvePinnedMutationTarget?.({
        filePath: params.sourcePath,
        action: "mkdir",
      });
      if (
        pathContains(
          normalizeSandboxAbsolutePath(
            canonicalSource?.policyPath ?? params.sourcePath,
            "copy source path",
          ),
          normalizeSandboxAbsolutePath(
            canonicalDestination?.policyPath ?? params.destinationPath,
            "copy destination path",
          ),
        )
      ) {
        throw new Error("Cannot recursively copy a directory into itself.");
      }
      await fsBridge.mkdirp({
        filePath: params.destinationPath,
        pinnedPath: canonicalDestination?.pinnedPath,
      });
      for (const entry of await this.listDirectoryEntries(
        params.sourcePath,
        params.fsSandboxPolicy,
      )) {
        if (!entry.isDirectory && !entry.isFile) {
          throw new Error(`Cannot copy unsupported filesystem entry: ${entry.fileName}`);
        }
        await this.copySandboxPath({
          sourcePath: joinSandboxChildPath(params.sourcePath, entry.fileName),
          destinationPath: joinSandboxChildPath(params.destinationPath, entry.fileName),
          recursive: true,
          fsSandboxPolicy: params.fsSandboxPolicy,
        });
      }
      return;
    }

    if (sourceStat.type === "file" && fsBridge.copyFile) {
      await fsBridge.copyFile({
        sourcePath: params.sourcePath,
        destinationPath: params.destinationPath,
        mkdir: true,
        pinnedPath: canonicalDestination?.pinnedPath,
      });
      return;
    }

    // Shipped third-party bridges may not expose streaming copy yet. Keep their
    // buffered fallback bounded while built-in bridges use the path-native copy above.
    assertSandboxFileReadWithinLimit(sourceStat);
    const data = await fsBridge.readFile({
      filePath: params.sourcePath,
      maxBytes: CODEX_SANDBOX_EXEC_SERVER_MAX_READ_FILE_BYTES,
    });
    await fsBridge.writeFile({
      filePath: params.destinationPath,
      data,
      mkdir: true,
      pinnedPath: canonicalDestination?.pinnedPath,
    });
  }
}
