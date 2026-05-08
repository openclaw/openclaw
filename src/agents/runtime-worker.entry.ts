import { parentPort, workerData } from "node:worker_threads";
import type { MessagePort } from "node:worker_threads";
import type { createSqliteAgentCacheStore as CreateSqliteAgentCacheStore } from "./cache/agent-cache-store.sqlite.js";
import type { createSqliteRunArtifactStore as CreateSqliteRunArtifactStore } from "./filesystem/run-artifact-store.sqlite.js";
import type { createSqliteToolArtifactStore as CreateSqliteToolArtifactStore } from "./filesystem/tool-artifact-store.sqlite.js";
import type { createSqliteVirtualAgentFs as CreateSqliteVirtualAgentFs } from "./filesystem/virtual-agent-fs.sqlite.js";
import type {
  AgentRuntimeControlMessage,
  AgentRuntimeBackend,
  AgentRuntimeContext,
  AgentRunResult,
  PreparedAgentRun,
} from "./runtime-backend.js";
import type {
  AgentWorkerMessage,
  AgentWorkerParentMessage,
  AgentWorkerRequest,
} from "./runtime-worker.js";

type VirtualAgentFsModule = {
  createSqliteVirtualAgentFs: typeof CreateSqliteVirtualAgentFs;
};

type ToolArtifactStoreModule = {
  createSqliteToolArtifactStore: typeof CreateSqliteToolArtifactStore;
};

type RunArtifactStoreModule = {
  createSqliteRunArtifactStore: typeof CreateSqliteRunArtifactStore;
};

type AgentCacheStoreModule = {
  createSqliteAgentCacheStore: typeof CreateSqliteAgentCacheStore;
};

let virtualAgentFsModulePromise: Promise<VirtualAgentFsModule> | null = null;
let toolArtifactStoreModulePromise: Promise<ToolArtifactStoreModule> | null = null;
let runArtifactStoreModulePromise: Promise<RunArtifactStoreModule> | null = null;
let agentCacheStoreModulePromise: Promise<AgentCacheStoreModule> | null = null;

async function loadVirtualAgentFsModule(): Promise<VirtualAgentFsModule> {
  virtualAgentFsModulePromise ??= import("./filesystem/virtual-agent-fs.sqlite.js").catch(
    async (error: unknown) => {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "ERR_MODULE_NOT_FOUND") {
        throw error;
      }
      return (await import("./filesystem/virtual-agent-fs.sqlite.ts")) as VirtualAgentFsModule;
    },
  ) as Promise<VirtualAgentFsModule>;
  return virtualAgentFsModulePromise;
}

async function loadToolArtifactStoreModule(): Promise<ToolArtifactStoreModule> {
  toolArtifactStoreModulePromise ??= import("./filesystem/tool-artifact-store.sqlite.js").catch(
    async (error: unknown) => {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "ERR_MODULE_NOT_FOUND") {
        throw error;
      }
      return (await import("./filesystem/tool-artifact-store.sqlite.ts")) as ToolArtifactStoreModule;
    },
  ) as Promise<ToolArtifactStoreModule>;
  return toolArtifactStoreModulePromise;
}

async function loadRunArtifactStoreModule(): Promise<RunArtifactStoreModule> {
  runArtifactStoreModulePromise ??= import("./filesystem/run-artifact-store.sqlite.js").catch(
    async (error: unknown) => {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "ERR_MODULE_NOT_FOUND") {
        throw error;
      }
      return (await import("./filesystem/run-artifact-store.sqlite.ts")) as RunArtifactStoreModule;
    },
  ) as Promise<RunArtifactStoreModule>;
  return runArtifactStoreModulePromise;
}

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
  const { createSqliteVirtualAgentFs } = await loadVirtualAgentFsModule();
  const { createSqliteToolArtifactStore } = await loadToolArtifactStoreModule();
  const { createSqliteRunArtifactStore } = await loadRunArtifactStoreModule();
  const scratch = createSqliteVirtualAgentFs({
    agentId: preparedRun.agentId,
    namespace: `run:${preparedRun.runId}`,
  });
  const artifacts = createSqliteToolArtifactStore({
    agentId: preparedRun.agentId,
    runId: preparedRun.runId,
  });
  const runArtifacts = createSqliteRunArtifactStore({
    agentId: preparedRun.agentId,
    runId: preparedRun.runId,
  });
  return {
    scratch,
    artifacts,
    runArtifacts,
    ...(preparedRun.filesystemMode === "vfs-only"
      ? {}
      : { workspace: { root: preparedRun.workspaceDir } }),
  };
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
