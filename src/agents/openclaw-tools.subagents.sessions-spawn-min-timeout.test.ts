import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionsSpawnTool } from "./tools/sessions-spawn-tool.js";

type SessionsSpawnConfig = ReturnType<(typeof import("../config/config.js"))["loadConfig"]>;
type GatewayCall = { method?: string; params?: Record<string, unknown> };

const callGatewayMock = vi.fn();
let configOverride: SessionsSpawnConfig = {
  routing: {
    sessions: {
      mainKey: "agent:test:main",
    },
  },
};

function setSubagentConfig(subagents?: Record<string, unknown>) {
  configOverride = {
    routing: {
      sessions: {
        mainKey: "agent:test:main",
      },
    },
    ...(subagents
      ? {
          agents: {
            defaults: {
              subagents,
            },
          },
        }
      : {}),
  } as SessionsSpawnConfig;
}

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => configOverride,
  };
});

vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => null,
}));

function findLastCall(calls: GatewayCall[], predicate: (call: GatewayCall) => boolean) {
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    const call = calls[i];
    if (call && predicate(call)) {
      return call;
    }
  }
  return undefined;
}

async function runSpawnAndReadTimeout(params: {
  callId: string;
  runTimeoutSeconds?: number;
  subagentsConfig?: Record<string, unknown>;
}) {
  setSubagentConfig(params.subagentsConfig);

  const tool = createSessionsSpawnTool({ agentSessionKey: "agent:test:main" });
  const spawnArgs: { task: string; runTimeoutSeconds?: number } = {
    task: "hello",
  };
  if (typeof params.runTimeoutSeconds === "number") {
    spawnArgs.runTimeoutSeconds = params.runTimeoutSeconds;
  }
  const result = await tool.execute(params.callId, spawnArgs);
  expect(result.details).toMatchObject({ status: "accepted" });

  const calls = callGatewayMock.mock.calls.map((call) => call[0] as GatewayCall);
  const agentCall = findLastCall(calls, (call) => call.method === "agent");
  return agentCall?.params?.timeout;
}

describe("sessions_spawn minRunTimeoutSeconds floor", () => {
  beforeEach(() => {
    setSubagentConfig();
    callGatewayMock.mockReset();
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as GatewayCall;
      if (request.method === "agent") {
        return { runId: "run-123" };
      }
      return {};
    });
  });

  it("clamps positive timeout up when below floor", async () => {
    const timeout = await runSpawnAndReadTimeout({
      callId: "call-1",
      runTimeoutSeconds: 120,
      subagentsConfig: { minRunTimeoutSeconds: 300 },
    });

    expect(timeout).toBe(300);
  });

  it("keeps positive timeout unchanged when above floor", async () => {
    const timeout = await runSpawnAndReadTimeout({
      callId: "call-2",
      runTimeoutSeconds: 600,
      subagentsConfig: { minRunTimeoutSeconds: 300 },
    });

    expect(timeout).toBe(600);
  });

  it("keeps timeout=0 unchanged even when floor is set", async () => {
    const timeout = await runSpawnAndReadTimeout({
      callId: "call-3",
      runTimeoutSeconds: 0,
      subagentsConfig: { minRunTimeoutSeconds: 300 },
    });

    expect(timeout).toBe(0);
  });

  it("keeps timeout unchanged when floor is not configured", async () => {
    const timeout = await runSpawnAndReadTimeout({
      callId: "call-4",
      runTimeoutSeconds: 120,
    });

    expect(timeout).toBe(120);
  });

  it("floor applies to cfgSubagentTimeout fallback when agent omits runTimeoutSeconds", async () => {
    const timeout = await runSpawnAndReadTimeout({
      callId: "call-5",
      subagentsConfig: { runTimeoutSeconds: 60, minRunTimeoutSeconds: 120 },
    });

    expect(timeout).toBe(120);
  });
});
