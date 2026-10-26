import type { WorkboardExecution } from "@openclaw/workboard-contract";
import { vi } from "vitest";
import type { OpenClawPluginService } from "../api.js";
import type { createWorkboardLifecycleService } from "./lifecycle-sync.js";

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
