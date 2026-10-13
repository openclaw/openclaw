import { vi } from "vitest";

vi.mock("../../agent-tool-definition-adapter.js", async (importOriginal) => {
  const {
    createClientToolNameConflictError,
    findClientToolNameConflicts,
    isClientToolNameConflictError,
    toClientToolDefinitions,
  } = await importOriginal<typeof import("../../agent-tool-definition-adapter.js")>();
  return {
    createClientToolNameConflictError,
    findClientToolNameConflicts,
    isClientToolNameConflictError,
    toClientToolDefinitions,
    toToolDefinitions: (tools: unknown[]) => tools,
  };
});
