import { beforeEach, describe, expect, it, vi } from "vitest";

const loggers: Array<Record<string, unknown>> = [];

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: vi.fn(() => {
    const logger = {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    loggers.push(logger);
    return logger;
  }),
}));

vi.mock("./sdk.js", () => ({
  loadClaudeAgentSdk: vi.fn(),
}));

vi.mock("./tool-bridge.js", () => ({
  bridgeClawdbrainToolsToMcpServer: vi.fn(),
}));

import { loadClaudeAgentSdk } from "./sdk.js";
import { bridgeClawdbrainToolsToMcpServer } from "./tool-bridge.js";

const mockLoadSdk = vi.mocked(loadClaudeAgentSdk);
const mockBridge = vi.mocked(bridgeClawdbrainToolsToMcpServer);

async function* eventsFrom<T>(events: T[]): AsyncIterable<T> {
  for (const event of events) {
    yield event;
  }
}

beforeEach(() => {
  loggers.length = 0;
  vi.clearAllMocks();

  mockLoadSdk.mockResolvedValue({
    query: vi
      .fn()
      .mockReturnValue(eventsFrom([{ type: "result", subtype: "success", result: "ok" }])),
  } as any);
  mockBridge.mockResolvedValue({
    serverConfig: { type: "sdk" as const, name: "clawdbrain", instance: {} },
    allowedTools: ["mcp__clawdbrain__exec"],
    toolCount: 1,
    registeredTools: ["exec"],
    skippedTools: [],
  });
});

describe("runSdkAgent MCP tools logging", () => {
  it("logs only real MCP tools as {server}:{tool} (not native tools bridged through MCP)", async () => {
    const { runSdkAgent } = await import("./sdk-runner.js");

    await runSdkAgent({
      runId: "run-1",
      sessionId: "sess-1",
      prompt: "hi",
      workspaceDir: "/tmp/workspace",
      tools: [{ name: "exec" }, { name: "mcp__github__create_issue" }] as any,
    });

    const logger = loggers[0] as any;
    expect(logger?.info).toBeTypeOf("function");

    const infoCalls = (logger.info as any).mock.calls.map((c: unknown[]) => String(c[0]));
    const mcpLine = infoCalls.find((l) => l.includes("sdk mcp tools:"));
    expect(mcpLine).toBeTruthy();
    expect(mcpLine).toContain("mcpTools=github:create_issue");
    expect(mcpLine).not.toContain("clawdbrain:exec");
  });
});
