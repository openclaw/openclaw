import { vi } from "vitest";

vi.mock("../../agent-tool-definition-adapter.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agent-tool-definition-adapter.js")>()),
  toToolDefinitions: (tools: unknown[]) => tools,
}));
