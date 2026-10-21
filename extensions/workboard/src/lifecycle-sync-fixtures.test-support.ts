import type { WorkboardExecution, WorkboardStatus } from "@openclaw/workboard-contract";
import { expect, vi } from "vitest";
import type { OpenClawPluginService } from "../api.js";
import {
  createWorkboardLifecycleService,
  readWorkboardLifecycleSessions,
} from "./lifecycle-sync.js";
import type { WorkboardStore } from "./store.js";

type Context = Parameters<OpenClawPluginService["start"]>[0];
export type LifecycleSnapshot = Awaited<
  ReturnType<ReturnType<typeof createWorkboardLifecycleService>["readSessions"]>
>;
type Session = LifecycleSnapshot["sessions"][number];

export function serviceContext(
  logger: Context["logger"] = { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
): Context {
  return { config: {}, stateDir: "unused", logger };
}

export function execution(
  sessionKey: string,
  runId = "run-1",
  status: WorkboardExecution["status"] = "running",
): WorkboardExecution {
  return {
    id: `exec-${runId}`,
    kind: "agent-session",
    mode: "autonomous",
    status,
    sessionKey,
    runId,
    startedAt: 1000,
    updatedAt: 1000,
  };
}

export const lifecycleSession = (
  key: string,
  status: Session["status"],
  updatedAt?: number,
  hasActiveRun = false,
): Session => ({ key, status, updatedAt, hasActiveRun });
export const lifecycleSnapshot = (...sessions: Session[]): LifecycleSnapshot => ({
  sessions,
  complete: true,
});

export function lifecycleFixture(params: Parameters<typeof createWorkboardLifecycleService>[0]) {
  const context = serviceContext();
  const service = createWorkboardLifecycleService(params);
  const operations = vi.spyOn(params.store, "runOperation");
  const stop = () => {
    service.onGatewayStop();
    service.stop();
  };
  const settle = async () => {
    expect(operations).toHaveBeenCalled();
    // The outer admitted operation includes all SQLite reads, writes, and cleanup.
    await operations.mock.results[0]?.value;
  };
  return {
    context,
    async start() {
      await service.start(context);
    },
    async sweep(signal?: AbortSignal) {
      operations.mockClear();
      service.onGatewayStart(signal);
      await settle();
    },
    stop,
    async [Symbol.asyncDispose]() {
      stop();
      await operations.mock.results[0]?.value;
      operations.mockRestore();
    },
  };
}

export function sessionGateway(
  sessions: (Session & { title?: string; archivedAt?: number })[],
  agentIds = [...new Set(sessions.map((session) => session.key.split(":")[1]))],
) {
  let returnedRows = 0;
  const request = vi.fn<Parameters<typeof readWorkboardLifecycleSessions>[0]["request"]>(
    async (method, query = {}) => {
      if (method === "agents.list") {
        return { agents: agentIds.map((id) => ({ id })) };
      }
      if (method === "sessions.describe") {
        const session = sessions.find((row) => row.key === query.key) ?? null;
        returnedRows += session ? 1 : 0;
        return { session };
      }
      const search = String(query.search);
      return {
        sessions: sessions
          .filter((row) => row.key.includes(search) || row.title?.includes(search))
          .slice(0, Number(query.limit)),
      };
    },
  );
  return {
    request,
    get returnedRows() {
      return returnedRows;
    },
    readSessions: (options: Parameters<typeof readWorkboardLifecycleSessions>[1]) =>
      readWorkboardLifecycleSessions({ isAvailable: async () => true, request }, options),
  };
}

export async function createLinkedCard(
  store: WorkboardStore,
  options: {
    status?: WorkboardStatus;
    sessionKey?: string;
    runId?: string;
    execution?: WorkboardExecution;
    agentId?: string;
    boardId?: string;
  } = {},
) {
  return await store.create({
    ...options,
    title: "Gateway-owned lifecycle",
    status: options.status ?? "running",
  });
}
