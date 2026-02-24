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
            runTimeoutSeconds: 900,
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

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => null,
}));

type GatewayCall = { method: string; params?: Record<string, unknown> };

async function getGatewayCalls(): Promise<GatewayCall[]> {
  const { callGateway } = await import("../gateway/call.js");
  return (callGateway as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
    (call) => call[0] as GatewayCall,
  );
}

function findLastCall(calls: GatewayCall[], predicate: (call: GatewayCall) => boolean) {
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    const call = calls[i];
    if (call && predicate(call)) {
      return call;
    }
  }
  return undefined;
}

describe("sessions_spawn default runTimeoutSeconds", () => {
  it("uses config default when agent omits runTimeoutSeconds", async () => {
    const tool = createSessionsSpawnTool({ agentSessionKey: "agent:test:main" });
    const result = await tool.execute("call-1", { task: "hello" });
    expect(result.details).toMatchObject({ status: "accepted" });

    const calls = await getGatewayCalls();
    const agentCall = findLastCall(calls, (call) => call.method === "agent");
    expect(agentCall?.params?.timeout).toBe(900);
  });

  it("explicit runTimeoutSeconds wins over config default", async () => {
    const tool = createSessionsSpawnTool({ agentSessionKey: "agent:test:main" });
    const result = await tool.execute("call-2", { task: "hello", runTimeoutSeconds: 300 });
    expect(result.details).toMatchObject({ status: "accepted" });

    const calls = await getGatewayCalls();
    const agentCall = findLastCall(calls, (call) => call.method === "agent");
    expect(agentCall?.params?.timeout).toBe(300);
  });
});
