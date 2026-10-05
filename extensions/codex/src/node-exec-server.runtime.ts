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
import {
  parseCodexNodeGitHubControl,
  encodeCodexNodeGitHubControl,
} from "./node-github-refresh.js";
import { createCodexNodeResourceReadiness } from "./node-resource-readiness.js";

const MAX_CODEX_EXEC_SERVER_MESSAGE_BYTES = 64 * 1024 * 1024;
const MAX_CODEX_EXEC_SERVER_STDERR_BYTES = 4 * 1024;
// Pinned Codex 0.160.0 transport.rs:113 emits this before reading the one-shot
// initialize request. Its package integration test guards this internal contract.
const CODEX_EXEC_SERVER_READY_LINE =
  "codex_exec_server::server::transport: codex-exec-server listening on stdio";
const CODEX_EXEC_SERVER_TERMINATION_GRACE_MS = 1_000;
const CODEX_EXEC_SERVER_REAP_TIMEOUT_MS = 5_000;
const NODE_EXEC_SERVER_PLATFORM_ENVIRONMENT =
  /^(?:SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|TMPDIR)$/iu;

/** Decode only valid UTF-8 runs; binary bytes outside credential text stay exact. */
function redactNodeExecOutput(chunk: Buffer, redact: (text: string) => string): Buffer {
  const utf8 =
    // eslint-disable-next-line no-control-regex -- Classify all UTF-8 bytes, including binary output controls.
    /(?:[\x00-\x7f]|[\xc2-\xdf][\x80-\xbf]|\xe0[\xa0-\xbf][\x80-\xbf]|[\xe1-\xec\xee-\xef][\x80-\xbf]{2}|\xed[\x80-\x9f][\x80-\xbf]|\xf0[\x90-\xbf][\x80-\xbf]{2}|[\xf1-\xf3][\x80-\xbf]{3}|\xf4[\x80-\x8f][\x80-\xbf]{2})+/g;
  const parts: Buffer[] = [];
  let offset = 0;
  for (const match of chunk.toString("latin1").matchAll(utf8)) {
    parts.push(chunk.subarray(offset, match.index));
    const end = match.index + match[0].length;
    parts.push(Buffer.from(redact(chunk.subarray(match.index, end).toString("utf8"))));
    offset = end;
  }
  parts.push(chunk.subarray(offset));
  return Buffer.concat(parts);
}

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
  workspace: Awaited<
    ReturnType<
      NonNullable<
        NonNullable<
          Parameters<
            import("openclaw/plugin-sdk/plugin-entry").OpenClawPluginNodeHostCommand["handle"]
          >[2]
        >["acquireManagedWorkspaceAsync"]
      >
    >
  >;
  io: OpenClawPluginNodeHostCommandIo;
  activeProcesses: Set<() => Promise<void>>;
  github?: import("openclaw/plugin-sdk/github-worker-runtime").WorkerGitHubLaunchBinding;
  resourcePreparationRequired?: boolean;
}): Promise<string> {
  const { io } = params;
  const resources = createCodexNodeResourceReadiness({
    required: params.resourcePreparationRequired,
    repository: params.workspace.repositoryReadiness,
    signal: io.signal,
    assertCurrent: () => {
      params.assertExecAuthorized();
      params.workspace.processEnvironment?.assertCurrent();
    },
  });
  const workspace = { ...params.workspace, repositoryReadiness: resources.readiness };
  const frames = io.frames;
  const cwd = workspace.workspaceDir;
  let writes: Promise<void> | undefined;
  const repositoryWaits = new Set<Promise<void>>();
  let githubControlWork = Promise.resolve();
  let output: Promise<void> | undefined;
  let temporaryHome: TempWorkspace | undefined;
  let unsubscribe: (() => void) | undefined;
  const releaseResources = async () => {
    try {
      await Promise.allSettled([output, writes, githubControlWork, ...repositoryWaits]);
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
    let githubEnv: Record<string, string> = {};
    let refreshGitHub:
      | ((snapshot: { token: string; expiresAtMs?: number }) => Promise<void>)
      | undefined;
    let githubGeneration = 0;
    let installedGitHub: { token: string; expiresAtMs?: number } | undefined;
    if (params.github) {
      const login = params.github.login;
      const { managedGitHubIdentityEnvironment, writeManagedGitHubProfileFiles } =
        await import("openclaw/plugin-sdk/github-worker-runtime");
      const profileDir = path.join(dir, "github");
      const host = params.github.host ?? "github.com";
      await writeManagedGitHubProfileFiles(profileDir, { ...params.github, host });
      refreshGitHub = async (snapshot) => {
        params.assertExecAuthorized();
        io.signal.throwIfAborted();
        if (snapshot.expiresAtMs !== undefined && snapshot.expiresAtMs <= Date.now()) {
          throw new Error("Node GitHub refresh expired");
        }
        await writeManagedGitHubProfileFiles(
          profileDir,
          { host, login, token: snapshot.token },
          {
            assertCurrent: () => {
              params.assertExecAuthorized();
              io.signal.throwIfAborted();
            },
          },
        );
        params.assertExecAuthorized();
        io.signal.throwIfAborted();
      };
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
        // Codex brokers GH_TOKEN across every GHE.com tenant. The host-keyed gh
        // profile supplies stock commands without registering this token with the broker.
        GH_TOKEN: "",
        GH_ENTERPRISE_TOKEN: "",
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
    // Generic host inheritance stays minimal; the exact workspace lease alone
    // supplies admitted provider transport and platform trust after sanitization.
    const baseEnv = sanitizeEnvVars(process.env, {
      strictMode: true,
      customAllowedPatterns: [NODE_EXEC_SERVER_PLATFORM_ENVIRONMENT],
    }).allowed;
    if (io.signal.aborted) {
      throw nodeExecServerAbortError(io.signal);
    }
    // Awaited setup is complete; policy and invocation closure win at spawn.
    params.assertExecAuthorized();
    workspace.processEnvironment?.assertCurrent();
    const processEnv = workspace.processEnvironment?.prepare(baseEnv) ?? baseEnv;
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
          if (!workspace.processEnvironment) {
            return frames.send(message);
          }
          const decoded: unknown = JSON.parse(Buffer.from(message).toString("utf8"));
          if (
            isRecord(decoded) &&
            decoded.method === "process/output" &&
            isRecord(decoded.params) &&
            typeof decoded.params.chunk === "string"
          ) {
            decoded.params.chunk = redactNodeExecOutput(
              Buffer.from(decoded.params.chunk, "base64"),
              workspace.processEnvironment.redactOutput,
            ).toString("base64");
          }
          return frames.send(
            validateNodeExecServerMessage(
              Buffer.from(workspace.processEnvironment.redactOutput(JSON.stringify(decoded))),
            ),
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
      const rawDiagnostic = stderr.toString("utf8").trim();
      const diagnostic = workspace.processEnvironment?.redactOutput(rawDiagnostic) ?? rawDiagnostic;
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
      if (params.resourcePreparationRequired && message[0] !== 0) {
        const resourceControl = resources.settle(JSON.parse(Buffer.from(message).toString("utf8")));
        if (resourceControl) {
          return frames.send(Buffer.from(JSON.stringify(resourceControl)));
        }
      }
      const control = parseCodexNodeGitHubControl(message);
      if (control) {
        const operation = githubControlWork.then(async () => {
          if (
            control.type !== "openclaw.github.profile" ||
            !refreshGitHub ||
            control.generation < githubGeneration
          ) {
            return;
          }
          let ok =
            control.generation === githubGeneration &&
            installedGitHub?.token === control.token &&
            installedGitHub.expiresAtMs === control.expiresAtMs;
          try {
            if (control.generation > githubGeneration) {
              await refreshGitHub(control);
              githubGeneration = control.generation;
              installedGitHub = { token: control.token, expiresAtMs: control.expiresAtMs };
              ok = true;
            }
          } catch {
            /* The sender retains the old grant until a successful acknowledgement. */
          }
          io.signal.throwIfAborted();
          params.assertExecAuthorized();
          await frames.send(
            encodeCodexNodeGitHubControl({
              type: "openclaw.github.profile.ack",
              generation: control.generation,
              ok,
            }),
          );
        });
        githubControlWork = operation.catch(() => {});
        return operation;
      }
      let encoded = validateNodeExecServerMessage(message);
      if (params.github || workspace.processEnvironment) {
        const request: unknown = JSON.parse(encoded.toString("utf8"));
        if (isRecord(request) && request.method === "process/start") {
          if (!isRecord(request.params) || !isRecord(request.params.env)) {
            throw new Error("Codex process/start requires an environment object.");
          }
          // Native Codex applies envPolicy before this overlay. The admitted
          // profile must survive inherit:none and narrower caller filters.
          const environment: NodeJS.ProcessEnv = {};
          for (const [key, value] of Object.entries(request.params.env)) {
            if (typeof value !== "string") {
              throw new Error("Codex process/start environment values must be strings.");
            }
            environment[key] = value;
          }
          request.params.env = {
            ...(workspace.processEnvironment?.prepare(environment) ?? environment),
            ...githubEnv,
          };
          encoded = validateNodeExecServerMessage(Buffer.from(JSON.stringify(request)));
        }
      }
      const request: unknown = JSON.parse(encoded.toString("utf8"));
      const dependent =
        isRecord(request) &&
        typeof request.method === "string" &&
        (request.method === "process/start" || request.method.startsWith("fs/"));
      const forward = async () => {
        params.assertExecAuthorized();
        workspace.processEnvironment?.assertCurrent();
        io.signal.throwIfAborted();
        if (dependent && workspace.repositoryReadiness) {
          try {
            // Native startup discovers instructions through metadata. Report pending
            // synchronously; waiting here would block the first conversational turn.
            if (
              isRecord(request) &&
              (request.method === "fs/getMetadata" || request.method === "fs/canonicalize")
            ) {
              workspace.repositoryReadiness.assertCurrent();
            }
            await workspace.repositoryReadiness.wait(io.signal);
            params.assertExecAuthorized();
            io.signal.throwIfAborted();
            workspace.repositoryReadiness.assertCurrent();
          } catch {
            await frames.send(
              Buffer.from(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: isRecord(request) ? request.id : null,
                  error: {
                    code: -32001,
                    message:
                      "Repository preparation failed, was cancelled, or its worker is no longer current; this operation did not run.",
                  },
                }),
              ),
            );
            return;
          }
        }
        workspace.processEnvironment?.assertCurrent();
        return await writeNodeExecServerMessage(child, encoded, io.signal);
      };
      // Repository admission must not stall initialize, cancellation, or process control.
      if (dependent && workspace.repositoryReadiness) {
        if (repositoryWaits.size >= 64) {
          throw new Error("Too many pending repository operations");
        }
        const operation = forward();
        repositoryWaits.add(operation);
        void operation.finally(() => repositoryWaits.delete(operation)).catch(() => undefined);
        return operation;
      }
      const operation = writes ? writes.then(forward) : forward();
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
