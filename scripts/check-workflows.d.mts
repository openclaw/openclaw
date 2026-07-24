export function windowsProcessTreeKillCommand(
  pid: number | undefined,
): { command: "taskkill"; args: string[] } | null;

export function timeoutTerminationPlan(
  platform: string,
  pid: number | undefined,
): Array<
  | { type: "taskkill"; command: "taskkill"; args: string[] }
  | { type: "child-kill"; signal: "SIGKILL" }
  | { type: "process-group"; signal: "SIGTERM" | "SIGKILL"; delayMs?: number }
>;
