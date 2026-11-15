import type { SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import {
  createCpuTrackedWorker,
  resolveRuntimeWorkerUrl,
} from "openclaw/plugin-sdk/process-runtime";
import { codexStdioWorkerEntrypoint } from "../../stdio-worker-entrypoint.js";

export type CodexStdioWorkerRequest =
  | { type: "launch"; command: string; args: string[]; options: SpawnOptions }
  | { type: "kill"; signal: NodeJS.Signals }
  | { type: "close" };

type WorkerReply =
  | { type: "ready" }
  | { type: "spawn"; pid: number }
  | { type: "exit"; code: number | null; signal: NodeJS.Signals | null }
  | { type: "error"; error: NodeJS.ErrnoException & { message: string } };

/** Native process facts plus bounded stdio streams; the Worker is not the process. */
export type CodexStdioChild = EventEmitter & {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  pid?: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
  unref(): void;
};

export function spawnCodexStdio(
  command: string,
  args: string[],
  options: SpawnOptions,
  assertCurrent?: () => void | Promise<void>,
): CodexStdioChild {
  const url = resolveRuntimeWorkerUrl(codexStdioWorkerEntrypoint);
  const worker = createCpuTrackedWorker(url, {
    // The worker imports only built-ins; supported Node and Bun run its source
    // TypeScript directly, without inheriting the host's CLI preloads.
    execArgv: [],
    stdin: true,
    stdout: true,
    stderr: true,
  });
  const streams: Omit<CodexStdioChild, keyof EventEmitter> = {
    stdin: worker.stdin!,
    stdout: worker.stdout!,
    stderr: worker.stderr!,
    pid: undefined,
    exitCode: null,
    signalCode: null,
    kill(signal: NodeJS.Signals = "SIGTERM") {
      worker.postMessage({ type: "kill", signal } satisfies CodexStdioWorkerRequest, []);
      return true;
    },
    unref() {
      worker.unref();
    },
  };
  const child = Object.assign(new EventEmitter(), streams);
  let failureReported = false;
  const fail = (error: unknown, notStarted = false) => {
    failureReported = true;
    if (notStarted) {
      child.exitCode = -1;
    }
    child.emit("error", toErrorObject(error, "Codex stdio worker failed"));
  };
  worker.on("error", (error) => fail(error));
  worker.on("message", (message: WorkerReply) => {
    switch (message.type) {
      case "ready":
        // Worker startup can await filesystem I/O; admission belongs to the live caller.
        void Promise.resolve()
          .then(() => assertCurrent?.())
          .then(() =>
            worker.postMessage(
              { type: "launch", command, args, options } satisfies CodexStdioWorkerRequest,
              [],
            ),
          )
          .catch((error: unknown) => {
            worker.postMessage({ type: "close" } satisfies CodexStdioWorkerRequest, []);
            fail(error, true);
          });
        break;
      case "spawn":
        child.pid = message.pid;
        child.emit("spawn");
        break;
      case "exit":
        child.exitCode = message.code;
        child.signalCode = message.signal;
        child.emit("exit", message.code, message.signal);
        // Match ChildProcess's exit drain, including pipes without active readers.
        process.nextTick(() => {
          child.stdout.resume();
          child.stderr.resume();
        });
        break;
      case "error":
        fail(
          Object.assign(new Error(message.error.message), message.error),
          child.pid === undefined,
        );
        break;
    }
  });
  worker.once("exit", () => {
    if (!failureReported && child.exitCode === null && child.signalCode === null) {
      fail(new Error("Codex stdio worker exited before observing process exit"));
    }
    child.stdout.resume();
    child.stderr.resume();
    child.emit("close", child.exitCode, child.signalCode);
  });
  return child;
}
