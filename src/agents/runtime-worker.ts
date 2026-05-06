import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type {
  AgentRunEvent,
  AgentRunResult,
  AgentRuntimeControlMessage,
  PreparedAgentRun,
} from "./runtime-backend.js";
import { assertPreparedAgentRunSerializable } from "./runtime-backend.js";
import { createRunEventBus } from "./runtime-event-bus.js";
import {
  buildNodePermissionExecArgv,
  type AgentWorkerPermissionProfile,
} from "./runtime-worker-permissions.js";

export type AgentWorkerRequest = {
  backendModuleUrl: string;
  preparedRun: PreparedAgentRun;
};

export type AgentWorkerMessage =
  | { type: "event"; event: AgentRunEvent }
  | { type: "result"; result: AgentRunResult }
  | { type: "error"; error: string };

export type AgentWorkerParentMessage = {
  type: "control";
  message: AgentRuntimeControlMessage;
};

export type AgentWorkerControlChannel = {
  send(message: AgentRuntimeControlMessage): void;
};

export type RunPreparedAgentInWorkerOptions = {
  backendModuleUrl: string;
  workerEntryUrl?: URL;
  permissionProfile?: AgentWorkerPermissionProfile;
  signal?: AbortSignal;
  onEvent?: (event: AgentRunEvent) => void | Promise<void>;
  onControlChannel?: (channel: AgentWorkerControlChannel) => void;
};

function defaultWorkerEntryUrl(): URL {
  return new URL("./runtime-worker.entry.js", import.meta.url);
}

function resolveWorkerExecArgv(workerEntryUrl: URL): string[] {
  const execArgv = [...process.execArgv];
  const pathname = workerEntryUrl.protocol === "file:" ? fileURLToPath(workerEntryUrl) : "";
  if (!pathname.endsWith(".ts")) {
    return execArgv;
  }
  const hasTsxLoader = execArgv.some((arg, index) => {
    return (
      arg === "tsx" ||
      arg === "--import=tsx" ||
      (arg === "--import" && execArgv[index + 1] === "tsx")
    );
  });
  return hasTsxLoader ? execArgv : [...execArgv, "--import", "tsx"];
}

export async function runPreparedAgentInWorker(
  preparedRun: PreparedAgentRun,
  options: RunPreparedAgentInWorkerOptions,
): Promise<AgentRunResult> {
  const serializableRun = assertPreparedAgentRunSerializable(preparedRun);
  const workerEntryUrl = options.workerEntryUrl ?? defaultWorkerEntryUrl();
  const worker = new Worker(workerEntryUrl, {
    workerData: {
      backendModuleUrl: options.backendModuleUrl,
      preparedRun: serializableRun,
    } satisfies AgentWorkerRequest,
    execArgv: [
      ...resolveWorkerExecArgv(workerEntryUrl),
      ...buildNodePermissionExecArgv(options.permissionProfile),
    ],
  });

  let settled = false;
  const eventBus = createRunEventBus({ onEvent: options.onEvent });
  options.onControlChannel?.({
    send: (message) => {
      const parentMessage = {
        type: "control",
        message,
      } satisfies AgentWorkerParentMessage;
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node worker MessagePort, not Window.postMessage.
      worker.postMessage(parentMessage);
    },
  });

  try {
    return await new Promise<AgentRunResult>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const abort = () => {
        rejectOnce(new Error("Agent worker aborted."));
      };
      const cleanup = () => {
        if (timeout) {
          clearTimeout(timeout);
        }
        options.signal?.removeEventListener("abort", abort);
      };
      const rejectOnce = (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        void worker.terminate();
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      const resolveOnce = (result: AgentRunResult) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(result);
      };
      timeout = setTimeout(() => {
        rejectOnce(new Error(`Agent worker timed out after ${serializableRun.timeoutMs}ms`));
      }, serializableRun.timeoutMs);
      if (options.signal?.aborted) {
        abort();
        return;
      }
      options.signal?.addEventListener("abort", abort, { once: true });
      worker.once("error", (error) => {
        rejectOnce(error);
      });
      worker.once("exit", (code) => {
        if (!settled && code !== 0) {
          rejectOnce(new Error(`Agent worker exited with code ${code}`));
        }
      });
      worker.on("message", (message: AgentWorkerMessage) => {
        if (message.type === "event") {
          void eventBus.emit(message.event).catch((error: unknown) => {
            rejectOnce(error);
          });
          return;
        }
        if (message.type === "result") {
          void eventBus
            .drain()
            .then(() => {
              resolveOnce(message.result);
            })
            .catch((error: unknown) => {
              rejectOnce(error);
            });
          return;
        }
        rejectOnce(new Error(message.error));
      });
    });
  } finally {
    await worker.terminate().catch(() => undefined);
  }
}
