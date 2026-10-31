import type { CodexThreadItem } from "./protocol.js";

export function createNativeCommandItem(
  overrides: Pick<CodexThreadItem, "id"> & Partial<CodexThreadItem>,
) {
  return {
    type: "commandExecution",
    command: "pnpm test extensions/codex",
    cwd: "/workspace",
    processId: null,
    source: "agent",
    status: "completed",
    commandActions: [],
    aggregatedOutput: null,
    exitCode: 0,
    durationMs: 42,
    ...overrides,
  };
}
