import { CodexAppServerRpcError } from "./rpc-error.js";

export const CODEX_CONTROL_METHODS = {
  account: "account/read",
  installedApps: "app/installed",
  listApps: "app/list",
  readApps: "app/read",
  feedback: "feedback/upload",
  forkThread: "thread/fork",
  listHooks: "hooks/list",
  listMcpServers: "mcpServerStatus/list",
  listPlugins: "plugin/list",
  listSkills: "skills/list",
  listThreads: "thread/list",
  listThreadTurns: "thread/turns/list",
  listThreadItems: "thread/items/list",
  readThread: "thread/read",
  rateLimits: "account/rateLimits/read",
  archiveThread: "thread/archive",
  renameThread: "thread/name/set",
  resumeThread: "thread/resume",
  review: "review/start",
  installPlugin: "plugin/install",
  reloadMcpServers: "config/mcpServer/reload",
  unarchiveThread: "thread/unarchive",
  getThreadGoal: "thread/goal/get",
  setThreadGoal: "thread/goal/set",
  clearThreadGoal: "thread/goal/clear",
} as const;

export type CodexControlMethod = (typeof CODEX_CONTROL_METHODS)[keyof typeof CODEX_CONTROL_METHODS];

export function describeControlFailure(error: unknown): string {
  if (error instanceof CodexAppServerRpcError && error.code === -32601) {
    return "unsupported by this Codex app-server";
  }
  return error instanceof Error ? error.message : String(error);
}
