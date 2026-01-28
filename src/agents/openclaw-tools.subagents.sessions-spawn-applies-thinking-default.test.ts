import { describe, expect, it, vi } from "vitest";
import { createSessionsSpawnTool } from "./tools/sessions-spawn-tool.js";

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual("../config/config.js");
  return {
    ...actual,
    loadConfig: () => ({
      agents: {
        defaults: {
          subagents: {
            thinking: "high",
          },
        },
      },
      routing: {
        sessions: {
          mainKey: "agent:test:main",
        },
      },
    }),
  };
});

vi.mock("../gateway/call.js", () => {
  return {
    callGateway: vi.fn(async ({ method }: { method: string }) => {
      if (method === "agent") {
        return { runId: "run-123" };
      }
      return {};
    }),
  };
});

describe("sessions_spawn thinking defaults", () => {
  it("applies agents.defaults.subagents.thinking when thinking is omitted", async () => {
    const tool = createSessionsSpawnTool({ agentSessionKey: "agent:test:main" });
    const result = await tool.execute("call-1", { task: "hello" });
    expect(result.details).toMatchObject({ status: "accepted" });

    const { callGateway } = await import("../gateway/call.js");
    const calls = (callGateway as unknown as ReturnType<typeof vi.fn>).mock.calls;

    const agentCall = calls
      .map((call) => call[0] as { method: string; params?: Record<string, unknown> })
      .findLast((call) => call.method === "agent");

    expect(agentCall?.params?.thinking).toBe("high");
  });

  it("prefers explicit sessions_spawn.thinking over config default", async () => {
    const tool = createSessionsSpawnTool({ agentSessionKey: "agent:test:main" });
    const result = await tool.execute("call-2", { task: "hello", thinking: "low" });
    expect(result.details).toMatchObject({ status: "accepted" });

    const { callGateway } = await import("../gateway/call.js");
    const calls = (callGateway as unknown as ReturnType<typeof vi.fn>).mock.calls;

    const agentCall = calls
      .map((call) => call[0] as { method: string; params?: Record<string, unknown> })
      .findLast((call) => call.method === "agent");

    expect(agentCall?.params?.thinking).toBe("low");
  });
});
