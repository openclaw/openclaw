import type { WorkboardSessionFacts, WorkboardSessionsColumn } from "@openclaw/workboard-contract";

export const BOARD_ID = "sessions";
export const NOW = 10_000_000;
export const FOCUS_COLUMN: WorkboardSessionsColumn = {
  id: "focus",
  label: "Focus",
  description: "Active sessions.",
  match: { run: ["active"] },
};
export const OTHER_COLUMN: WorkboardSessionsColumn = {
  id: "other",
  label: "Other",
  description: "Remaining sessions.",
  fallback: true,
};
export const DEFAULT_COLUMNS = ["needs-input", "stuck", "working", "in-review", "merged", "done"];

export function facts(
  id: string,
  overrides: Partial<WorkboardSessionFacts> = {},
): WorkboardSessionFacts {
  return {
    key: `agent:main:${id}`,
    sessionId: `session-${id}`,
    agentId: "main",
    label: id,
    run: "idle",
    pullRequests: [],
    archived: false,
    lastActivityAt: NOW,
    ...overrides,
  };
}
