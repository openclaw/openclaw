import { vi } from "vitest";

vi.mock("../../agent-tool-definition-adapter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agent-tool-definition-adapter.js")>();
  return {
    ...actual,
    toToolDefinitions: (tools: unknown[]) => tools,
  };
});
