import type { DatabaseSync } from "node:sqlite";
import { runIngest } from "./ingest/handler.js";
import { createSidecarOpener } from "./sidecar-store.js";

// Public-config gate. Reads `memoryV2.ingest.enabled` from the plugin config
// without any schema dep; default is false. Type-guarded so a malformed config
// never enables ingest by accident.
export function readIngestEnabled(pluginConfig: unknown): boolean {
  if (!isRecord(pluginConfig)) {
    return false;
  }
  const memoryV2 = pluginConfig.memoryV2;
  if (!isRecord(memoryV2)) {
    return false;
  }
  const ingest = memoryV2.ingest;
  if (!isRecord(ingest)) {
    return false;
  }
  return ingest.enabled === true;
}

type AgentEndEvent = {
  messages: unknown[];
  success: boolean;
  error?: string;
  durationMs?: number;
};

type AgentEndContext = {
  sessionId?: string;
  workspaceDir?: string;
};

export type AgentEndHandler = (event: AgentEndEvent, ctx: AgentEndContext) => void;

export type IngestWiringDeps = {
  // Resolves and opens (lazily) the per-workspace sidecar db. Cached by
  // workspace path so all turns of the same agent share a connection.
  openDb?: (workspaceDir: string) => DatabaseSync;
  // Injected for tests; defaults to runIngest.
  runIngest?: typeof runIngest;
  // Logger surface; defaults to a noop. Wiring should never throw.
  logWarn?: (message: string, err?: unknown) => void;
  // Clock injection point; defaults to Date.now.
  now?: () => number;
};

export function buildAgentEndHandler(deps: IngestWiringDeps = {}): AgentEndHandler {
  const openDb = deps.openDb ?? createSidecarOpener();
  const ingest = deps.runIngest ?? runIngest;
  const logWarn = deps.logWarn ?? (() => {});
  const now = deps.now ?? Date.now;

  return (event, ctx) => {
    try {
      if (!event.success) {
        return;
      }
      if (!ctx.workspaceDir) {
        return;
      }
      if (!ctx.sessionId) {
        return;
      }
      const db = openDb(ctx.workspaceDir);
      ingest(
        { messages: event.messages, success: event.success },
        { sessionId: ctx.sessionId },
        { db, now },
      );
    } catch (err) {
      logWarn("memory-v2 ingest failed", err);
    }
  };
}

type RegisterApi = {
  pluginConfig?: unknown;
  on: (hookName: "agent_end", handler: AgentEndHandler) => unknown;
};

export function registerMemoryV2Ingest(api: RegisterApi, deps: IngestWiringDeps = {}): boolean {
  if (!readIngestEnabled(api.pluginConfig)) {
    return false;
  }
  api.on("agent_end", buildAgentEndHandler(deps));
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
