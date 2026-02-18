import { beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayMock = vi.fn();
vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

vi.mock("./subagent-depth.js", () => ({
  getSubagentDepthFromSessionStore: () => 0,
}));

vi.mock("./subagent-registry.js", () => ({
  countActiveRunsForSession: () => 0,
  registerSubagentRun: vi.fn(),
  resetSubagentRegistryForTests: vi.fn(),
}));

let configOverride: ReturnType<(typeof import("../config/config.js"))["loadConfig"]> = {
  session: { mainKey: "main", scope: "per-sender" },
};

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => configOverride,
    resolveGatewayPort: () => 18789,
  };
});

import { spawnSubagentDirect } from "./subagent-spawn.js";

const BASE_CTX = {
  agentSessionKey: "agent:main:abc123",
};

function setupGatewayMock(runId = "run-1") {
  let capturedSessionKey: string | undefined;
  callGatewayMock.mockImplementation(async (opts: unknown) => {
    const req = opts as { method?: string; params?: Record<string, unknown> };
    if (req.method === "agent") {
      capturedSessionKey = req.params?.sessionKey as string | undefined;
      return { runId };
    }
    return {};
  });
  return { getSessionKey: () => capturedSessionKey };
}

describe("spawnSubagentDirect: sessionKey", () => {
  beforeEach(() => {
    configOverride = { session: { mainKey: "main", scope: "per-sender" } };
    callGatewayMock.mockReset();
  });

  it("uses provided short sessionKey instead of random UUID", async () => {
    const { getSessionKey } = setupGatewayMock();

    const result = await spawnSubagentDirect(
      { task: "do thing", sessionKey: "alpha" },
      BASE_CTX,
    );

    expect(result.status).toBe("accepted");
    expect(getSessionKey()).toBe("agent:main:subagent:alpha");
    expect(result.childSessionKey).toBe("agent:main:subagent:alpha");
  });

  it("falls back to random UUID when sessionKey is not provided", async () => {
    const { getSessionKey } = setupGatewayMock("run-2");

    const result = await spawnSubagentDirect({ task: "do thing" }, BASE_CTX);

    expect(result.status).toBe("accepted");
    expect(getSessionKey()).toMatch(/^agent:main:subagent:[0-9a-f-]{36}$/);
  });

  it("accepts fully-qualified sessionKey when agentId matches", async () => {
    const { getSessionKey } = setupGatewayMock("run-3");

    const result = await spawnSubagentDirect(
      { task: "do thing", sessionKey: "agent:main:subagent:bravo" },
      BASE_CTX,
    );

    expect(result.status).toBe("accepted");
    expect(getSessionKey()).toBe("agent:main:subagent:bravo");
  });

  it("rejects fully-qualified sessionKey targeting a different agent", async () => {
    callGatewayMock.mockResolvedValue({});

    const result = await spawnSubagentDirect(
      { task: "do thing", sessionKey: "agent:other:subagent:foo" },
      BASE_CTX,
    );

    expect(result.status).toBe("error");
    expect(result.error).toMatch(/sessionKey agentId mismatch/);
  });
});
