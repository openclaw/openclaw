import type { WorkboardExecution } from "@openclaw/workboard-contract";

export function codexExecution(
  id: string,
  startedAt: number,
  overrides: Partial<WorkboardExecution> = {},
): WorkboardExecution {
  return {
    id,
    kind: "agent-session",
    engine: "codex",
    mode: "autonomous",
    status: "running",
    model: "openai/gpt-5.5",
    startedAt,
    updatedAt: startedAt,
    ...overrides,
  };
}
