import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenClawPluginNodeHostCommandIo } from "openclaw/plugin-sdk/node-host";
import type { OpenClawPluginNodeHostCommand } from "openclaw/plugin-sdk/plugin-entry";
import { WebSocketServer, WebSocket } from "ws";
import { runCodexNodeExecServer } from "./node-exec-server.runtime.js";
type CommandContext = NonNullable<Parameters<OpenClawPluginNodeHostCommand["handle"]>[2]>;
type WorkspaceLease = Awaited<
  ReturnType<NonNullable<CommandContext["acquireManagedWorkspaceAsync"]>>
>;

/** The app-server selects this worker-local carrier; only typed file/process effects wait. */
export async function createCodexNodeWorkspaceEnvironment(params: {
  workspace: WorkspaceLease;
  signal: AbortSignal;
  assertExecAuthorized: () => void;
  github?: import("openclaw/plugin-sdk/github-worker-runtime").WorkerGitHubLaunchBinding;
}) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, maxPayload: 64 * 1024 * 1024 });
  try {
    await once(server, "listening", { signal: params.signal });
  } catch (error) {
    server.close();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Worker execution environment did not bind loopback");
  }
  const id = `openclaw-workspace-${randomUUID()}`;
  const route = `/${randomUUID()}`;
  const controller = new AbortController();
  const signal = AbortSignal.any([params.signal, controller.signal]);
  let acquired = false;
  let running: Promise<string> | undefined;
  let socket: WebSocket | undefined;
  signal.addEventListener("abort", () => socket?.terminate(), { once: true });
  let closing: Promise<void> | undefined;
  const processes = new Set<() => Promise<void>>();
  server.on("connection", (connected, request) => {
    if (acquired || request.url !== route || request.headers.origin || signal.aborted) {
      connected.close(1008, "Execution environment is unavailable");
      return;
    }
    acquired = true;
    socket = connected;
    const ready = createDeferred<void>();
    let receive: ((message: Uint8Array) => void | Promise<void>) | undefined;
    const io: OpenClawPluginNodeHostCommandIo = {
      signal,
      emitChunk: async () => {},
      onInput: () => {},
      frames: {
        send: (message) =>
          new Promise<void>((resolve, reject) => {
            if (connected.readyState !== WebSocket.OPEN) {
              reject(new Error("Worker execution environment disconnected"));
              return;
            }
            connected.send(message, (error) => (error ? reject(error) : resolve()));
          }),
        onMessage: (listener) => {
          receive = listener;
          ready.resolve();
          return () => {
            receive = undefined;
          };
        },
      },
    };
    connected.on("message", (data) => {
      const bytes = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data);
      const delivery = (async () => {
        await ready.promise;
        signal.throwIfAborted();
        params.assertExecAuthorized();
        await receive?.(bytes);
      })();
      void delivery.catch(() =>
        controller.abort(new Error("Worker execution environment request failed")),
      );
    });
    connected.once("close", () =>
      controller.abort(new Error("Worker execution environment disconnected")),
    );
    connected.once("error", () =>
      controller.abort(new Error("Worker execution environment transport failed")),
    );
    running = runCodexNodeExecServer({
      ...params,
      workspace: { ...params.workspace, release: () => {} },
      io,
      activeProcesses: processes,
    });
    void running
      .finally(() => {
        ready.resolve();
        controller.abort(new Error("Worker execution environment exited"));
      })
      .catch(() => undefined);
  });
  return {
    id,
    url: `ws://127.0.0.1:${address.port}${route}`,
    cwd: params.workspace.workspaceDir,
    signal,
    async close() {
      return await (closing ??= (async () => {
        controller.abort(new Error("Worker execution environment closed"));
        socket?.terminate();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          });
        });
        const outcomes = await Promise.allSettled([...processes].map((stop) => stop()));
        await running?.catch(() => undefined);
        const errors = outcomes.flatMap((outcome) =>
          outcome.status === "rejected" ? [outcome.reason] : [],
        );
        if (errors.length) {
          throw new AggregateError(errors, "Worker execution environment cleanup did not settle");
        }
      })());
    },
  };
}
