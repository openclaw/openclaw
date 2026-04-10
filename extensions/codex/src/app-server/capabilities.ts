export const CODEX_CONTROL_METHODS = {
  account: "account/read",
  compact: "thread/compact/start",
  listMcpServers: "mcpServerStatus/list",
  listSkills: "skills/list",
  listThreads: "thread/list",
  rateLimits: "account/rateLimits/read",
  resumeThread: "thread/resume",
  review: "review/start",
} as const;

export type CodexControlName = keyof typeof CODEX_CONTROL_METHODS;
export type CodexControlMethod = (typeof CODEX_CONTROL_METHODS)[CodexControlName];

export function describeControlFailure(error: string): string {
  return isUnsupportedControlError(error) ? "unsupported by this Codex app-server" : error;
}

function isUnsupportedControlError(error: string): boolean {
  return /method not found|unknown method|unsupported method|-32601/i.test(error);
}
