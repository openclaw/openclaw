/** Owns approved, connection-bound Codex exec-server processes on paired nodes. */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { stripVTControlCharacters } from "node:util";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenClawPluginNodeHostCommandIo } from "openclaw/plugin-sdk/node-host";
import { killProcessTree } from "openclaw/plugin-sdk/process-runtime";
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
  let fragments: Buffer[] = [];
  let pendingBytes = 0;
  for await (const rawChunk of child.stdout) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    let offset = 0;
    while (offset < chunk.byteLength) {
      const newline = chunk.indexOf(0x0a, offset);
      const fragment = chunk.subarray(offset, newline === -1 ? chunk.byteLength : newline);
      const nextLength = pendingBytes + fragment.byteLength;
      if (nextLength > MAX_CODEX_EXEC_SERVER_MESSAGE_BYTES + 1) {
        throw new Error("Codex exec-server stdout message exceeds its 64 MiB limit.");
      }
      if (fragment.byteLength > 0) {
        fragments.push(fragment);
      }
      pendingBytes = nextLength;
      if (newline === -1) {
        if (
          pendingBytes > MAX_CODEX_EXEC_SERVER_MESSAGE_BYTES &&
          fragment[fragment.byteLength - 1] !== 0x0d
        ) {
          throw new Error("Codex exec-server stdout message exceeds its 64 MiB limit.");
        }
        break;
      }
      const trailing = fragments.at(-1);
      if (trailing?.[trailing.byteLength - 1] === 0x0d) {
        pendingBytes -= 1;
        if (trailing.byteLength === 1) {
          fragments.pop();
        } else {
          fragments[fragments.length - 1] = trailing.subarray(0, trailing.byteLength - 1);
        }
      }
      const pending =
        fragments.length === 1 ? fragments[0]! : Buffer.concat(fragments, pendingBytes);
      const message = validateNodeExecServerMessage(pending);
      fragments = [];
      pendingBytes = 0;
      await send(message);
      offset = newline + 1;
    }
  }
  if (pendingBytes > 0) {
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
  workspace: { workspaceDir: string; homeDir?: string; release: () => void };
  io: OpenClawPluginNodeHostCommandIo;
  activeProcesses: Set<() => Promise<void>>;
  github?: import("openclaw/plugin-sdk/github-worker-runtime").WorkerGitHubLaunchBinding;
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
  let rejectDisconnected!: (error: Error) => void;
  const disconnected = new Promise<never>((_resolve, reject) => {
    rejectDisconnected = reject;
  });
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
    let githubEnv: Record<string, string> = {};
    if (params.github) {
      const { managedGitHubIdentityEnvironment, writeManagedGitHubProfileFiles } =
        await import("openclaw/plugin-sdk/github-worker-runtime");
      const profileDir = path.join(dir, "github");
      const host = params.github.host ?? "github.com";
      await writeManagedGitHubProfileFiles(profileDir, { ...params.github, host });
      githubEnv = {
        ...managedGitHubIdentityEnvironment({
          profileDir,
          gitAuthor: params.github.gitAuthor,
          gitConfig: [
            ["credential.helper", ""],
            ["credential.helper", "!gh auth git-credential"],
          ],
        }),
        GH_HOST: host,
        ...(host === "github.com"
          ? { GH_TOKEN: params.github.token, GH_ENTERPRISE_TOKEN: "" }
          : { GH_TOKEN: "", GH_ENTERPRISE_TOKEN: params.github.token }),
        GITHUB_TOKEN: "",
        GITHUB_ENTERPRISE_TOKEN: "",
      };
    }
    const resolved = await resolveManagedCodexAppServerStartOptions({
      transport: "stdio",
      command: "codex",
      commandSource: "managed",
      managedCommandOrder: "package-first",
      args: ["exec-server", "--listen", "stdio"],
      headers: {},
    });
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
    // Awaited setup is complete; policy and invocation closure win at spawn.
    params.assertExecAuthorized();
    const nativeReady = createDeferred<void>();
    const exit = createDeferred<{ code: number | null; signal: NodeJS.Signals | null }>();
    let stderr = Buffer.alloc(0);
    let startupSettled = false;
    let pendingLine = "";
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
          ...githubEnv,
          ...(process.platform === "win32" ? { USERPROFILE: workspace.homeDir ?? dir } : {}),
        },
        clearEnv: ["NODE_OPTIONS"],
      },
      baseEnv,
      () => {
        if (io.signal.aborted) {
          throw nodeExecServerAbortError(io.signal);
        }
        params.assertExecAuthorized();
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
        output = relayNodeExecServerOutput(spawned, frames.send.bind(frames));
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
          if (startupSettled) {
            return;
          }
          const lines = (pendingLine + decoder.write(next)).split("\n");
          pendingLine = lines.pop()!;
          for (const line of [...lines, pendingLine]) {
            if (Buffer.byteLength(line, "utf8") > MAX_CODEX_EXEC_SERVER_STDERR_BYTES) {
              startupSettled = true;
              pendingLine = "";
              rejectDisconnected(new Error("Codex node startup diagnostic line exceeded 4 KiB."));
              return;
            }
          }
          if (
            lines.some((line) =>
              stripVTControlCharacters(line).trimEnd().endsWith(CODEX_EXEC_SERVER_READY_LINE),
            )
          ) {
            startupSettled = true;
            pendingLine = "";
            nativeReady.resolve();
          }
        });
      },
    );
    const closed = exit.promise;
    const stopped = closed.then((outcome) => {
      const diagnostic = stderr.toString("utf8").trim();
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
    unsubscribe = frames.onMessage((message) => {
      const encoded = validateNodeExecServerMessage(message);
      const operation = writes
        ? writes.then(() => writeNodeExecServerMessage(child, encoded, io.signal))
        : writeNodeExecServerMessage(child, encoded, io.signal);
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
