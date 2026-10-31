/** Owns one admitted worker-native app-server and its execution environment. */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  OpenClawPluginNodeHostCommandIo,
  OpenClawPluginNodeWorkspaceLease,
} from "openclaw/plugin-sdk/node-host";
import { createBoundedLineFramer } from "openclaw/plugin-sdk/process-runtime";
import { sanitizeEnvVars } from "openclaw/plugin-sdk/sandbox";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  resolveManagedCodexAppServerStartOptions,
  resolveManagedCodexNativeCommand,
  isManagedCodexDesktopCommand,
} from "./app-server/managed-binary.js";
import { createStdioTransport } from "./app-server/transport-stdio.js";
import {
  deriveCodexWorkerConfigurationVersion,
  resolveCodexWorkerAuthHelper,
} from "./node-app-server-command.js";
import { createCodexNodeAppServerProcessOwner } from "./node-app-server-process-owner.js";
import { createCodexNodeWorkspaceEnvironment } from "./node-app-server-workspace-environment.js";
import { createCodexNodeResourceReadiness } from "./node-resource-readiness.js";

const MAX_FRAME_BYTES = 64 * 1024 * 1024;

async function readPrivateFile(file: string) {
  const stat = await fs.lstat(file);
  if (
    !stat.isFile() ||
    stat.size > 16 * 1024 ||
    (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
  ) {
    throw new Error("Worker Codex configuration must be a private regular file");
  }
  return await fs.readFile(file, "utf8");
}

export async function readWorkerCodexRuntime(command: string) {
  const directory = path.join(resolveStateDir(process.env), "codex-runtime");
  const stat = await fs.lstat(directory);
  if (
    !stat.isDirectory() ||
    (await fs.realpath(directory)) !== directory ||
    (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
  ) {
    throw new Error("Worker Codex configuration directory is unsafe");
  }
  const [version, config] = await Promise.all([
    readPrivateFile(path.join(directory, "version")),
    readPrivateFile(path.join(directory, "config.toml")),
  ]);
  const helperPath = resolveCodexWorkerAuthHelper(config, directory);
  const helperScript = await readPrivateFile(helperPath);
  if (
    !command.endsWith("." + version) ||
    version !== deriveCodexWorkerConfigurationVersion(config, helperPath, helperScript)
  ) {
    throw new Error("Worker Codex configuration version is invalid; reprovision the worker");
  }
  return { directory, config };
}

function decodeFrame(frame: Uint8Array): Record<string, unknown> {
  if (
    !frame.byteLength ||
    frame.byteLength > MAX_FRAME_BYTES ||
    frame.includes(10) ||
    frame.includes(13)
  ) {
    throw new Error("Worker app-server requires one bounded JSON-RPC frame");
  }
  let request: unknown;
  try {
    request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame));
  } catch {
    throw new Error("Worker app-server received malformed JSON-RPC");
  }
  if (
    !isRecord(request) ||
    (typeof request.method !== "string" &&
      !("id" in request && ("result" in request || "error" in request)))
  ) {
    throw new Error("Worker app-server received an invalid JSON-RPC frame");
  }
  return request;
}

export async function runCodexNodeAppServer(params: {
  command: string;
  workspace: OpenClawPluginNodeWorkspaceLease;
  io: OpenClawPluginNodeHostCommandIo;
  activeProcesses: Set<() => Promise<void>>;
  assertExecAuthorized: () => void;
  sessionId: string;
  resourcePreparationRequired?: boolean;
}): Promise<string> {
  const controller = new AbortController();
  const signal = AbortSignal.any([params.io.signal, controller.signal]);
  const assertCurrent = () => {
    signal.throwIfAborted();
    params.assertExecAuthorized();
    params.workspace.processEnvironment?.assertCurrent();
  };
  const resources = createCodexNodeResourceReadiness({
    required: params.resourcePreparationRequired,
    signal,
    assertCurrent,
  });
  const workspace = { ...params.workspace, repositoryReadiness: resources.readiness };
  const frames = params.io.frames;
  let child: ChildProcessWithoutNullStreams | undefined;
  let unsubscribe: (() => void) | undefined;
  let environment: Awaited<ReturnType<typeof createCodexNodeWorkspaceEnvironment>> | undefined;
  let writes = Promise.resolve();
  const effects = new Set<Promise<void>>();
  const internal = new Map<string, ReturnType<typeof createDeferred<unknown>>>();
  const owner = createCodexNodeAppServerProcessOwner({
    child: () => child,
    unsubscribe: () => {
      unsubscribe?.();
      controller.abort(new Error("Worker app-server closed"));
      for (const pending of internal.values()) {
        pending.reject(new Error("Worker app-server closed"));
      }
      internal.clear();
    },
    release: async () => {
      await writes.catch(() => {});
      await Promise.allSettled(effects);
      await environment?.close();
      workspace.release();
    },
    activeProcesses: params.activeProcesses,
  });
  try {
    assertCurrent();
    if (!frames) {
      throw new Error("Worker app-server requires duplex frames");
    }
    const runtime = await readWorkerCodexRuntime(params.command);
    // HOME belongs to the existing workspace retention owner; no separate retained-disk promise.
    if (!workspace.homeDir) {
      throw new Error("Worker app-server requires an owned workspace home");
    }
    // Existing workspace retention collects runtime metadata after its last generation retires.
    const home = path.join(
      workspace.homeDir,
      ".openclaw-worker",
      "codex",
      createHash("sha256").update(params.sessionId).digest("hex"),
    );
    await fs.mkdir(home, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(home, "config.toml"), runtime.config, { mode: 0o600 });
    const resolved = await resolveManagedCodexAppServerStartOptions(
      {
        transport: "stdio",
        command: "codex",
        commandSource: "managed",
        managedCommandOrder: "package-first",
        args: ["app-server", "--listen", "stdio://"],
        headers: {},
      },
      { preferInstalled: false },
    );
    const native = resolveManagedCodexNativeCommand(resolved.command);
    if (!native || isManagedCodexDesktopCommand(resolved.command)) {
      throw new Error("Worker requires the pinned Codex package binary");
    }
    const base = sanitizeEnvVars(process.env, {
      strictMode: true,
      customAllowedPatterns: [/^(?:SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|TMPDIR)$/iu],
    }).allowed;
    assertCurrent();
    const closed = createDeferred<{ code: number | null; signal: NodeJS.Signals | null }>();
    const failed = createDeferred<never>();
    void failed.promise.catch(() => {});
    const onAbort = () => failed.reject(new Error("Worker app-server cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    let outgoing: Promise<void> = Promise.resolve();
    try {
      child = await createStdioTransport(
        {
          transport: "stdio",
          command: native,
          commandSource: "resolved-managed",
          args: resolved.args,
          headers: {},
          cwd: workspace.workspaceDir,
          env: {
            HOME: workspace.homeDir,
            CODEX_HOME: home,
            ...(process.platform === "win32" ? { USERPROFILE: workspace.homeDir } : {}),
          },
          clearEnv: ["NODE_OPTIONS", "OPENAI_API_KEY", "OPENAI_API_PROXY_KEY", "CODEX_API_KEY"],
        },
        workspace.processEnvironment?.prepare(base) ?? base,
        assertCurrent,
        (spawned) => {
          child = spawned;
          owner.observe();
          spawned.once("close", (code, exitSignal) => closed.resolve({ code, signal: exitSignal }));
          spawned.once("error", failed.reject);
          spawned.stdin.on("error", failed.reject);
          // Native stderr may include prompts or credentials. Drain it, never export raw content.
          spawned.stderr.resume();
          outgoing = (async () => {
            const framer = createBoundedLineFramer(
              MAX_FRAME_BYTES,
              "Worker app-server response exceeds 64 MiB",
            );
            for await (const chunk of spawned.stdout) {
              for (const frame of framer.push(Buffer.from(chunk))) {
                const message = decodeFrame(frame);
                const pending =
                  typeof message.id === "string" ? internal.get(message.id) : undefined;
                if (pending) {
                  internal.delete(String(message.id));
                  if (message.error) {
                    pending.reject(new Error("Worker environment registration failed"));
                  } else {
                    pending.resolve(message.result);
                  }
                } else {
                  await frames.send(
                    workspace.processEnvironment
                      ? Buffer.from(
                          workspace.processEnvironment.redactOutput(frame.toString("utf8")),
                        )
                      : frame,
                  );
                }
              }
            }
            if (framer.pendingByteLength) {
              throw new Error("Worker app-server ended with an incomplete frame");
            }
          })();
          void outgoing.catch(failed.reject);
        },
      );
      const activeChild = child;
      const send = async (request: Record<string, unknown>) => {
        assertCurrent();
        if (!activeChild.stdin.write(JSON.stringify(request) + "\n")) {
          await once(activeChild.stdin, "drain", { signal });
        }
      };
      let registration: Promise<void> | undefined;
      const ensureEnvironment = () =>
        (registration ??= (async () => {
          environment = await createCodexNodeWorkspaceEnvironment({
            workspace,
            signal,
            assertExecAuthorized: assertCurrent,
          });
          const id = "openclaw-environment-" + randomUUID();
          const response = createDeferred<unknown>();
          internal.set(id, response);
          await send({
            id,
            method: "environment/add",
            params: { environmentId: environment.id, execServerUrl: environment.url },
          });
          await Promise.race([response.promise, failed.promise]);
          assertCurrent();
        })());
      unsubscribe = frames.onMessage((frame) => {
        const request = decodeFrame(frame);
        const settled = resources.settle(request);
        if (settled) {
          return frames.send(Buffer.from(JSON.stringify(settled)));
        }
        if (
          resources.readiness &&
          (String(request.method).startsWith("fs/") ||
            request.method === "command/exec" ||
            String(request.method).startsWith("fuzzyFileSearch/"))
        ) {
          if (effects.size >= 64) {
            throw new Error("Too many pending worker filesystem operations");
          }
          const effect = (async () => {
            try {
              await resources.readiness!.wait(signal);
              assertCurrent();
              await send(request);
            } catch {
              if (!signal.aborted) {
                await frames.send(
                  Buffer.from(
                    JSON.stringify({
                      id: request.id,
                      error: {
                        code: -32001,
                        message:
                          "Private resource preparation is unavailable; this operation did not run.",
                      },
                    }),
                  ),
                );
              }
            }
          })();
          effects.add(effect);
          void effect.finally(() => effects.delete(effect)).catch(failed.reject);
          // Delivery controls must not queue behind the resource-dependent request.
          return undefined;
        }
        const operation = writes.then(async () => {
          // Resume has no environment field in the pinned protocol; turn/start selects the fresh carrier.
          if (["thread/start", "turn/start"].includes(String(request.method))) {
            await ensureEnvironment();
            if (!environment || !isRecord(request.params)) {
              throw new Error("Worker environment selection unavailable");
            }
            const selected = request.params.environments;
            request.params.environments =
              Array.isArray(selected) && selected.length === 0
                ? []
                : [{ environmentId: environment.id, cwd: workspace.workspaceDir }];
          }
          await send(request);
        });
        writes = operation.catch((error: unknown) => {
          failed.reject(error);
        });
        return operation;
      });
      const outcome = await Promise.race([closed.promise, failed.promise]);
      await outgoing;
      // A native exit is distinct from the transport owner's cancellation/close.
      await frames.send(
        Buffer.from(JSON.stringify({ method: "openclaw/process/exited", params: outcome })),
      );
      if (outcome.code !== 0 || outcome.signal) {
        throw new Error("Worker app-server exited unsuccessfully");
      }
      return "Worker app-server exited";
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  } finally {
    await owner.stop();
  }
}
