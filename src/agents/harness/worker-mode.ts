export type AgentWorkerLaunchMode = "auto" | "inline" | "worker";

export function normalizeAgentWorkerLaunchMode(value: string | undefined): AgentWorkerLaunchMode {
  switch ((value ?? "").trim().toLowerCase()) {
    case "1":
    case "on":
    case "true":
    case "worker":
    case "workers":
      return "worker";
    case "auto":
      return "auto";
    default:
      return "inline";
  }
}
