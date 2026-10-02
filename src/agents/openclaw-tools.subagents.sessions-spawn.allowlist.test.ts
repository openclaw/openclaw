import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSubagentSpawnTestConfig,
  loadSubagentSpawnModuleForTest,
  setupAcceptedSubagentGatewayMock,
} from "./subagents/spawn/subagent-spawn.test-helpers.js";

const hoisted = vi.hoisted(() => ({
  callGatewayMock: vi.fn(),
  configOverride: {} as Record<string, unknown>,
}));
let resetSubagentRegistryForTests: typeof import("./subagents/registry/subagent-registry.test-helpers.js").resetSubagentRegistryForTests;
let spawnSubagentDirect: typeof import("./subagents/spawn/subagent-spawn.js").spawnSubagentDirect;

function resolveAgentConfigFromList(cfg: Record<string, unknown>, agentId: string) {
  return (cfg.agents as { list?: Array<Record<string, unknown>> } | undefined)?.list?.find(
    (entry) => entry.id === agentId,
  );
}
function readSandboxMode(value: unknown) {
  return value && typeof value === "object" ? (value as { mode?: string }).mode : undefined;
}
function setConfig(next: Record<string, unknown>) {
  hoisted.configOverride = createSubagentSpawnTestConfig(undefined, next);
}
async function spawn(agentId?: string, sandbox?: "require") {
  return await spawnSubagentDirect(
    { task: "do thing", agentId, sandbox },
    { agentSessionKey: "agent:main:main", agentChannel: "mobilechat" },
  );
}
function expectRejected(result: Awaited<ReturnType<typeof spawn>>, error?: string) {
  expect(result.status).toBe("forbidden");
  if (error) {
    expect(result.error).toContain(error);
  }
  expect(hoisted.callGatewayMock).not.toHaveBeenCalled();
}

beforeAll(async () => {
  ({ resetSubagentRegistryForTests, spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({
    callGatewayMock: hoisted.callGatewayMock,
    getRuntimeConfig: () => hoisted.configOverride,
    resolveAgentConfig: resolveAgentConfigFromList,
    resolveSandboxRuntimeStatus: ({
      cfg = {},
      sessionKey,
    }: {
      cfg?: Record<string, unknown>;
      sessionKey?: string;
    }) => {
      const agent = resolveAgentConfigFromList(cfg, sessionKey?.split(":")[1] ?? "");
      const explicitMode = readSandboxMode(agent?.sandbox);
      const defaultMode = readSandboxMode(
        (cfg.agents as { defaults?: { sandbox?: unknown } } | undefined)?.defaults?.sandbox,
      );
      return {
        sandboxed:
          explicitMode === "all" ? true : explicitMode === "off" ? false : defaultMode === "all",
      };
    },
    resetModules: false,
    sessionStorePath: "/tmp/subagent-spawn-allowlist-session-store.json",
  }));
});

describe("subagent spawn target admission", () => {
  beforeEach(async () => {
    await resetSubagentRegistryForTests();
    hoisted.callGatewayMock.mockReset();
    setupAcceptedSubagentGatewayMock(hoisted.callGatewayMock);
    setConfig({});
  });

  it("forbids cross-agent targets outside the requester's allowlist", async () => {
    setConfig({ agents: { list: [{ id: "main", subagents: { allowAgents: ["alpha"] } }] } });
    expectRejected(await spawn("beta"));
  });

  it("falls back to the default allowlist when the agent omits allowAgents", async () => {
    setConfig({
      agents: {
        defaults: { subagents: { allowAgents: ["beta"] } },
        list: [{ id: "main" }, { id: "beta" }],
      },
    });
    expect(await spawn("beta")).toMatchObject({
      status: "accepted",
      childSessionKey: expect.stringMatching(/^agent:beta:subagent:/),
    });
  });

  it("allows configured agent IDs through the wildcard policy", async () => {
    setConfig({
      agents: {
        list: [{ id: "main", subagents: { allowAgents: ["*"] } }, { id: "my-research_agent01" }],
      },
    });
    expect(await spawn("my-research_agent01")).toMatchObject({ status: "accepted" });
  });

  it("rejects unconfigured targets even with a wildcard allowlist", async () => {
    setConfig({ agents: { list: [{ id: "main", subagents: { allowAgents: ["*"] } }] } });
    expectRejected(await spawn("beta"), 'agentId "beta" is not in the configured agent registry');
  });

  it("forbids a sandboxed requester from unsandboxing its child", async () => {
    setConfig({
      agents: {
        defaults: { sandbox: { mode: "all" } },
        list: [
          { id: "main", subagents: { allowAgents: ["research"] } },
          { id: "research", sandbox: { mode: "off" } },
        ],
      },
    });
    expectRejected(
      await spawn("research"),
      "Sandboxed sessions cannot spawn unsandboxed subagents.",
    );
  });

  it('forbids sandbox="require" when the target is unsandboxed', async () => {
    setConfig({
      agents: {
        list: [
          { id: "main", subagents: { allowAgents: ["research"] } },
          { id: "research", sandbox: { mode: "off" } },
        ],
      },
    });
    expectRejected(await spawn("research", "require"), 'sandbox="require"');
  });

  it("forbids omitted agentId when requireAgentId is configured", async () => {
    setConfig({
      agents: { defaults: { subagents: { requireAgentId: true } }, list: [{ id: "main" }] },
    });
    expectRejected(await spawn(), "sessions_spawn requires explicit agentId");
  });

  it("admits an explicit required target after normalizing its allowlist", async () => {
    setConfig({
      agents: {
        list: [
          { id: "main", subagents: { allowAgents: ["Research"], requireAgentId: true } },
          { id: "research" },
        ],
      },
    });
    expect(await spawn("research")).toMatchObject({
      status: "accepted",
      runId: "run-1",
      childSessionKey: expect.stringMatching(/^agent:research:subagent:/),
    });
  });

  it("rejects malformed agent IDs before normalization can create a ghost agent", async () => {
    setConfig({
      agents: { list: [{ id: "main", subagents: { allowAgents: ["*"] } }, { id: "research" }] },
    });
    expect(await spawn("Agent not found: xyz")).toMatchObject({
      status: "error",
      error: expect.stringContaining("Invalid agentId"),
    });
    expect(hoisted.callGatewayMock).not.toHaveBeenCalled();
  });
});
