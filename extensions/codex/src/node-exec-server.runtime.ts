/** Owns approved, connection-bound Codex exec-server processes on paired nodes. */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { stripVTControlCharacters } from "node:util";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenClawPluginNodeHostCommandIo } from "openclaw/plugin-sdk/node-host";
import { createBoundedLineFramer, killProcessTree } from "openclaw/plugin-sdk/process-runtime";
import { sanitizeEnvVars } from "openclaw/plugin-sdk/sandbox";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  resolvePreferredOpenClawTmpDir,
  tempWorkspace,
  type TempWorkspace,
} from "openclaw/plugin-sdk/temp-path";
import {
  isManagedCodexDesktopCommand,
  resolveManagedCodexAppServerStartOptions,
  resolveManagedCodexNativeCommand,
} from "./app-server/managed-binary.js";
import { createStdioTransport } from "./app-server/transport-stdio.js";
import { closeCodexAppServerTransportAndWait } from "./app-server/transport.js";

const MAX_CODEX_EXEC_SERVER_MESSAGE_BYTES = 64 * 1024 * 1024;
const MAX_CODEX_EXEC_SERVER_STDERR_BYTES = 4 * 1024;
// Pinned Codex 0.154.0 transport.rs:149 emits this before reading the one-shot
// initialize request. Its package integration test guards this internal contract.
const CODEX_EXEC_SERVER_READY_LINE =
  "codex_exec_server::server::transport: codex-exec-server listening on stdio";
const CODEX_EXEC_SERVER_TERMINATION_GRACE_MS = 1_000;
const CODEX_EXEC_SERVER_REAP_TIMEOUT_MS = 5_000;
const NODE_EXEC_SERVER_PLATFORM_ENVIRONMENT =
  /^(?:SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|TMPDIR)$/iu;

function validateNodeExecServerMessage(message: Uint8Array): Buffer {
  if (message.byteLength === 0 || message.byteLength > MAX_CODEX_EXEC_SERVER_MESSAGE_BYTES) {
    throw new Error("Codex exec-server JSON-RPC message exceeds its 64 MiB limit.");
  }
  const encoded = Buffer.from(message.buffer, message.byteOffset, message.byteLength);
  if (encoded.includes(0x0a) || encoded.includes(0x0d)) {
    throw new Error("Codex exec-server JSON-RPC frames must contain exactly one message.");
  }
  let decoded: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(encoded);
    decoded = JSON.parse(text) as unknown;
  } catch {
    throw new Error("Codex exec-server received malformed UTF-8 or JSON-RPC.");
  }
  if (
    !isRecord(decoded) ||
    (decoded.jsonrpc !== undefined && decoded.jsonrpc !== "2.0") ||
    (typeof decoded.method !== "string" &&
      !("id" in decoded && ("result" in decoded || "error" in decoded)))
  ) {
    throw new Error("Codex exec-server received an invalid JSON-RPC message.");
  }
  return encoded;
}

function nodeExecServerAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Codex node exec-server connection closed.");
}

function writeNodeExecServerMessage(
  child: ChildProcessWithoutNullStreams,
  message: Buffer,
  signal: AbortSignal,
): Promise<void> | void {
  if (signal.aborted) {
    throw nodeExecServerAbortError(signal);
  }
  const payload = Buffer.concat([message, Buffer.from("\n")]);
  if (!child.stdin.write(payload)) {
    return once(child.stdin, "drain", { signal }).then(() => undefined);
  }
}

async function relayNodeExecServerOutput(
  child: ChildProcessWithoutNullStreams,
  send: (message: Uint8Array) => Promise<void>,
): Promise<void> {
  const overflow = "Codex exec-server stdout message exceeds its 64 MiB limit.";
  const framer = createBoundedLineFramer(MAX_CODEX_EXEC_SERVER_MESSAGE_BYTES + 1, overflow);
  for await (const rawChunk of child.stdout) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    for (const line of framer.push(chunk)) {
      // Exec-server accepts CRLF; the shared byte framer preserves CR for its caller.
      const message = line.at(-1) === 0x0d ? line.subarray(0, -1) : line;
      await send(validateNodeExecServerMessage(message));
    }
    if (framer.pendingByteLength > MAX_CODEX_EXEC_SERVER_MESSAGE_BYTES && chunk.at(-1) !== 0x0d) {
      throw new Error(overflow);
    }
  }
  if (framer.pendingByteLength > 0) {
    throw new Error("Codex exec-server stdout ended with an unterminated JSON-RPC message.");
  }
}

function createNodeExecServerProcessOwner(
  child: ChildProcessWithoutNullStreams,
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
  releaseResources: () => Promise<void>,
  activeProcesses: Set<() => Promise<void>>,
): () => Promise<void> {
  let termination: Promise<void> | undefined;
  let hasClosed = false;
  const settled = closed.then(async () => {
    hasClosed = true;
    // Root closure can precede the transport's in-flight containment result.
    await termination?.catch(() => {});
    await releaseResources();
    activeProcesses.delete(terminate);
  });
  void settled.catch(() => {});
  const terminate = async (): Promise<void> => {
    if (!hasClosed) {
      await (termination ??= (async () => {
        // The shared transport closes only the root on Windows; taskkill /T
        // owns its descendants before that root can disappear.
        if (process.platform === "win32" && child.pid) {
          killProcessTree(child.pid, { graceMs: CODEX_EXEC_SERVER_TERMINATION_GRACE_MS });
        }
        const { exited } = await closeCodexAppServerTransportAndWait(child, {
          forceKillDelayMs: CODEX_EXEC_SERVER_TERMINATION_GRACE_MS,
          exitTimeoutMs: CODEX_EXEC_SERVER_REAP_TIMEOUT_MS,
        });
        if (!exited) {
          throw new Error("Codex node exec-server process tree did not terminate.");
        }
      })());
    }
    await settled;
  };
  activeProcesses.add(terminate);
  return terminate;
}

/** Runs the one-connection paired-node exec-server after lightweight command admission. */
export async function runCodexNodeExecServer(params: {
  assertExecAuthorized: () => void;
  workspace: import("openclaw/plugin-sdk/node-host").OpenClawPluginNodeWorkspaceLease & {
    repositoryReadiness?: { wait(signal: AbortSignal): Promise<void>; assertCurrent(): void };
  };
  io: OpenClawPluginNodeHostCommandIo;
  activeProcesses: Set<() => Promise<void>>;
}): Promise<string> {
  const { io, workspace } = params;
  const frames = io.frames;
  const cwd = workspace.workspaceDir;
  let writes: Promise<void> | undefined;
  let output: Promise<void> | undefined;
  let temporaryHome: TempWorkspace | undefined;
  let unsubscribe: (() => void) | undefined;
  const releaseResources = async () => {
    try {
      await Promise.allSettled([output, writes]);
      await temporaryHome?.cleanup();
    } finally {
      workspace.release();
    }
  };
  let close = releaseResources;
  const { promise: disconnected, reject: rejectDisconnected } = createDeferred<never>();
  void disconnected.catch(() => {});
  const onAbort = () => {
    const error = nodeExecServerAbortError(io.signal);
    rejectDisconnected(error);
  };
  io.signal.addEventListener("abort", onAbort, { once: true });

  try {
    if (!frames) {
      throw new Error("Codex node exec-server requires duplex frames.");
    }
    if (io.signal.aborted) {
      throw nodeExecServerAbortError(io.signal);
    }
    temporaryHome = await tempWorkspace({
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "codex-node-exec-server-",
    });
    const { dir } = temporaryHome;
    const codexHome = path.join(dir, ".codex");
    // Codex canonicalizes CODEX_HOME during startup and rejects missing directories.
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    const resolved = await resolveManagedCodexAppServerStartOptions(
      {
        transport: "stdio",
        command: "codex",
        commandSource: "managed",
        managedCommandOrder: "package-first",
        args: ["exec-server", "--listen", "stdio"],
        headers: {},
      },
      { preferInstalled: false },
    );
    const native = resolveManagedCodexNativeCommand(resolved.command);
    if (!native || isManagedCodexDesktopCommand(resolved.command)) {
      throw new Error("Codex node exec-server requires the pinned managed package binary.");
    }
    // The exec-server needs platform/locale basics, never provider, forge,
    // cloud, SSH-agent, XDG, or runtime-injection state from its node host.
    const baseEnv = sanitizeEnvVars(process.env, {
      strictMode: true,
      customAllowedPatterns: [NODE_EXEC_SERVER_PLATFORM_ENVIRONMENT],
    }).allowed;
    if (io.signal.aborted) {
      throw nodeExecServerAbortError(io.signal);
    }
    // The workspace lease owns admitted provider transport and trust after sanitization.
    const processEnv = workspace.processEnvironment?.prepare(baseEnv) ?? baseEnv;
    // Awaited setup is complete; policy and invocation closure win at spawn.
    params.assertExecAuthorized();
    workspace.processEnvironment?.assertCurrent();
    const nativeReady = createDeferred<void>();
    const exit = createDeferred<{ code: number | null; signal: NodeJS.Signals | null }>();
    let stderr = Buffer.alloc(0);
    let pendingLine: string | undefined = "";
    const decoder = new StringDecoder("utf8");
    const child = await createStdioTransport(
      {
        transport: "stdio",
        command: native,
        commandSource: "resolved-managed",
        args: resolved.args,
        headers: {},
        cwd,
        env: {
          HOME: workspace.homeDir ?? dir,
          CODEX_HOME: codexHome,
          RUST_LOG:
            "error,opentelemetry_sdk=off,opentelemetry_otlp=off,codex_exec_server::server::transport=info",
          ...(process.platform === "win32" ? { USERPROFILE: workspace.homeDir ?? dir } : {}),
        },
        clearEnv: ["NODE_OPTIONS"],
      },
      processEnv,
      () => {
        if (io.signal.aborted) {
          throw nodeExecServerAbortError(io.signal);
        }
        params.assertExecAuthorized();
        workspace.processEnvironment?.assertCurrent();
      },
      (spawned) => {
        // Observe before process registration yields: a fast child can emit
        // readiness or exit before createStdioTransport returns.
        spawned.once("close", (code, signal) => exit.resolve({ code, signal }));
        close = createNodeExecServerProcessOwner(
          spawned,
          exit.promise,
          releaseResources,
          params.activeProcesses,
        );
        output = relayNodeExecServerOutput(spawned, async (message) => {
          await frames.send(
            workspace.processEnvironment
              ? Buffer.from(
                  workspace.processEnvironment.redactOutput(Buffer.from(message).toString("utf8")),
                )
              : message,
          );
        });
        void output.catch((error: unknown) => {
          rejectDisconnected(error instanceof Error ? error : new Error(String(error)));
        });
        spawned.once("error", rejectDisconnected);
        spawned.stdin.on("error", rejectDisconnected);
        spawned.stderr.on("data", (chunk: Buffer | string) => {
          const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          stderr = Buffer.concat([
            stderr,
            next.subarray(-MAX_CODEX_EXEC_SERVER_STDERR_BYTES),
          ]).subarray(-MAX_CODEX_EXEC_SERVER_STDERR_BYTES);
          // Preserve a UTF-8 boundary in the bounded diagnostic tail.
          let start = 0;
          while (start < stderr.length && (stderr[start]! & 0xc0) === 0x80) {
            start++;
          }
          stderr = stderr.subarray(start);
          if (pendingLine === undefined) {
            return;
          }
          const lines = (pendingLine + decoder.write(next)).split("\n");
          pendingLine = lines.pop()!;
          for (const line of [...lines, pendingLine]) {
            if (Buffer.byteLength(line, "utf8") > MAX_CODEX_EXEC_SERVER_STDERR_BYTES) {
              pendingLine = undefined;
              rejectDisconnected(new Error("Codex node startup diagnostic line exceeded 4 KiB."));
              return;
            }
          }
          if (
            lines.some((line) =>
              stripVTControlCharacters(line).trimEnd().endsWith(CODEX_EXEC_SERVER_READY_LINE),
            )
          ) {
            pendingLine = undefined;
            nativeReady.resolve();
          }
        });
      },
    );
    const closed = exit.promise;
    const stopped = closed.then((outcome) => {
      const diagnostic = (
        workspace.processEnvironment?.redactOutput(stderr.toString("utf8")) ??
        stderr.toString("utf8")
      ).trim();
      throw new Error(
        `Codex node exec-server exited (code ${outcome.code ?? "none"}, signal ${outcome.signal ?? "none"})${diagnostic ? `: ${diagnostic}` : "."}`,
      );
    });
    await Promise.race([nativeReady.promise, stopped, disconnected]);
    if (io.signal.aborted) {
      throw nodeExecServerAbortError(io.signal);
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      await stopped;
    }
    params.assertExecAuthorized();
    // Framed readiness starts Codex's initialize budget. Native startup
    // belongs to this cancellable launch, before that handshake begins.
    const writeInput = (encoded: Buffer) => {
      const write = () => {
        io.signal.throwIfAborted();
        params.assertExecAuthorized();
        workspace.processEnvironment?.assertCurrent();
        return writeNodeExecServerMessage(child, encoded, io.signal);
      };
      const operation = writes ? writes.then(write) : write();
      if (!operation) {
        return undefined;
      }
      const observed = operation.catch(() => {});
      writes = observed;
      void observed.then(() => {
        if (writes === observed) {
          writes = undefined;
        }
      });
      return operation;
    };
    // Synchronous writes must stay synchronous: an async wrapper turns a ready
    // burst into outstanding deliveries and exhausts the duplex message bound.
    unsubscribe = frames.onMessage((message) => {
      const encoded = validateNodeExecServerMessage(message);
      if (!workspace.repositoryReadiness) {
        return writeInput(encoded);
      }
      const readiness = workspace.repositoryReadiness;
      const request: unknown = JSON.parse(encoded.toString("utf8"));
      const needsResources =
        isRecord(request) &&
        typeof request.method === "string" &&
        (request.method === "process/start" || request.method.startsWith("fs/"));
      if (!needsResources) {
        return writeInput(encoded);
      }
      return (async () => {
        try {
          // Native instruction discovery must receive pending metadata promptly;
          // waiting here blocks thread/start before conversational inference.
          if (request.method === "fs/getMetadata" || request.method === "fs/canonicalize") {
            readiness.assertCurrent();
          }
          await readiness.wait(io.signal);
          readiness.assertCurrent();
        } catch {
          io.signal.throwIfAborted();
          params.assertExecAuthorized();
          workspace.processEnvironment?.assertCurrent();
          await frames.send(
            Buffer.from(
              JSON.stringify({
                jsonrpc: "2.0",
                id: request.id,
                error: {
                  code: -32001,
                  message:
                    "Private resource preparation is unavailable; this operation did not run.",
                },
              }),
            ),
          );
          return;
        }
        return writeInput(encoded);
      })();
    });
    return await Promise.race([stopped, disconnected]);
  } finally {
    io.signal.removeEventListener("abort", onAbort);
    try {
      unsubscribe?.();
    } finally {
      await close();
    }
  }
}
