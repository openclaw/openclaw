import { parentPort, workerData } from "node:worker_threads";
import type { MessagePort } from "node:worker_threads";
import type { createSqliteAgentCacheStore as CreateSqliteAgentCacheStore } from "./cache/agent-cache-store.sqlite.js";
import type {
  AgentRuntimeControlMessage,
  AgentRuntimeBackend,
  AgentRuntimeContext,
  AgentRunResult,
  PreparedAgentRun,
} from "./runtime-backend.js";
import { createSqliteAgentRuntimeFilesystem } from "./runtime-filesystem.sqlite.js";
import type {
  AgentWorkerMessage,
  AgentWorkerParentMessage,
  AgentWorkerRequest,
} from "./runtime-worker.js";

type AgentCacheStoreModule = {
  createSqliteAgentCacheStore: typeof CreateSqliteAgentCacheStore;
};

let agentCacheStoreModulePromise: Promise<AgentCacheStoreModule> | null = null;

async function loadAgentCacheStoreModule(): Promise<AgentCacheStoreModule> {
  agentCacheStoreModulePromise ??= import("./cache/agent-cache-store.sqlite.js").catch(
    async (error: unknown) => {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "ERR_MODULE_NOT_FOUND") {
        throw error;
      }
      return (await import("./cache/agent-cache-store.sqlite.ts")) as AgentCacheStoreModule;
    },
  ) as Promise<AgentCacheStoreModule>;
  return agentCacheStoreModulePromise;
}

export async function createWorkerFilesystem(
  preparedRun: PreparedAgentRun,
): Promise<AgentRuntimeContext["filesystem"]> {
  return createSqliteAgentRuntimeFilesystem(preparedRun);
}

function post(message: AgentWorkerMessage): void {
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node worker MessagePort, not Window.postMessage.
  parentPort?.postMessage(message);
}

function createWorkerControl(options: {
  abortController: AbortController;
  port: MessagePort | null;
}): AgentRuntimeContext["control"] {
  const handlers = new Set<(message: AgentRuntimeControlMessage) => void | Promise<void>>();
  options.port?.on("message", (message: AgentWorkerParentMessage) => {
    if (message?.type !== "control") {
      return;
    }
    if (message.message.type === "cancel" && !options.abortController.signal.aborted) {
      options.abortController.abort(
        new Error(`Agent worker cancelled: ${message.message.reason ?? "cancel"}`),
      );
    }
    for (const handler of handlers) {
      void Promise.resolve(handler(message.message)).catch((error: unknown) => {
        post({ type: "error", error: formatWorkerError(error) });
      });
    }
  });
  return {
    onMessage(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
  };
}

function formatWorkerError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || error.message;
  }
  return String(error);
}

async function loadBackend(moduleUrl: string): Promise<AgentRuntimeBackend> {
  const mod = (await import(moduleUrl)) as {
    backend?: AgentRuntimeBackend;
    default?: AgentRuntimeBackend;
  };
  const backend = mod.backend ?? mod.default;
  if (!backend?.id || typeof backend.run !== "function") {
    throw new Error(`Agent worker backend module does not export a backend: ${moduleUrl}`);
  }
  return backend;
}

export async function createWorkerRuntimeContext(
  preparedRun: PreparedAgentRun,
  options: { port?: MessagePort | null } = {},
): Promise<AgentRuntimeContext> {
  const abortController = new AbortController();
  const { createSqliteAgentCacheStore } = await loadAgentCacheStoreModule();
  return {
    filesystem: await createWorkerFilesystem(preparedRun),
    cache: createSqliteAgentCacheStore({
      agentId: preparedRun.agentId,
      scope: `run:${preparedRun.runId}`,
    }),
    emit: (event) => {
      post({ type: "event", event });
    },
    signal: abortController.signal,
    control: createWorkerControl({
      abortController,
      port: options.port === undefined ? parentPort : options.port,
    }),
  };
}

async function main(): Promise<void> {
  const request = workerData as AgentWorkerRequest;
  const backend = await loadBackend(request.backendModuleUrl);
  const context = await createWorkerRuntimeContext(request.preparedRun);
  const result: AgentRunResult = await backend.run(request.preparedRun, context);
  post({ type: "result", result });
}

if (parentPort) {
  void main().catch((error: unknown) => {
    post({ type: "error", error: formatWorkerError(error) });
  });
}
