import { beforeAll, beforeEach, expect, it, vi } from "vitest";
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

function resolveAgentConfigFromEntries(cfg: Record<string, unknown>, agentId: string) {
  return (cfg.agents as { entries?: Record<string, Record<string, unknown>> } | undefined)
    ?.entries?.[agentId];
}
function readSandboxMode(value: unknown) {
  return value && typeof value === "object" ? (value as { mode?: string }).mode : undefined;
}
function setConfig(main = {}, targets = {}, defaults?: Record<string, unknown>) {
  hoisted.configOverride = createSubagentSpawnTestConfig(undefined, {
    agents: { entries: { main, ...targets }, ...(defaults ? { defaults } : {}) },
  });
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
    resolveAgentConfig: resolveAgentConfigFromEntries,
    resolveSandboxRuntimeStatus: ({
      cfg = {},
      sessionKey,
    }: {
      cfg?: Record<string, unknown>;
      sessionKey?: string;
    }) => {
      const agent = resolveAgentConfigFromEntries(cfg, sessionKey?.split(":")[1] ?? "");
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

beforeEach(async () => {
  await resetSubagentRegistryForTests();
  hoisted.callGatewayMock.mockReset();
  setupAcceptedSubagentGatewayMock(hoisted.callGatewayMock);
  hoisted.configOverride = createSubagentSpawnTestConfig();
});

it("forbids cross-agent targets outside the requester's allowlist", async () => {
  setConfig({ subagents: { allowAgents: ["alpha"] } });
  expectRejected(await spawn("beta"));
});

it("falls back to the default allowlist when the agent omits allowAgents", async () => {
  setConfig({}, { beta: {} }, { subagents: { allowAgents: ["beta"] } });
  expect(await spawn("beta")).toMatchObject({
    status: "accepted",
    childSessionKey: expect.stringMatching(/^agent:beta:subagent:/),
  });
});

it("rejects unconfigured targets even with a wildcard allowlist", async () => {
  setConfig({ subagents: { allowAgents: ["*"] } });
  expectRejected(await spawn("beta"), 'agentId "beta" is not in the configured agent registry');
});

it.each([
  {
    defaults: { sandbox: { mode: "all" } },
    sandbox: undefined,
    error: "Sandboxed sessions cannot spawn unsandboxed subagents.",
  },
  { defaults: undefined, sandbox: "require" as const, error: 'sandbox="require"' },
])("forbids an unsandboxed child: $error", async ({ defaults, sandbox, error }) => {
  setConfig(
    { subagents: { allowAgents: ["research"] } },
    { research: { sandbox: { mode: "off" } } },
    defaults,
  );
  expectRejected(await spawn("research", sandbox), error);
});

it("forbids omitted agentId when requireAgentId is configured", async () => {
  setConfig({}, {}, { subagents: { requireAgentId: true } });
  expectRejected(await spawn(), "sessions_spawn requires explicit agentId");
});

it("admits an explicit required target after normalizing its allowlist", async () => {
  setConfig({ subagents: { allowAgents: ["Research"], requireAgentId: true } }, { research: {} });
  expect(await spawn("research")).toMatchObject({
    status: "accepted",
    runId: "run-1",
    childSessionKey: expect.stringMatching(/^agent:research:subagent:/),
  });
});

it("rejects malformed agent IDs before normalization can create a ghost agent", async () => {
  setConfig({ subagents: { allowAgents: ["*"] } }, { research: {} });
  expect(await spawn("Agent not found: xyz")).toMatchObject({
    status: "error",
    error: expect.stringContaining("Invalid agentId"),
  });
  expect(hoisted.callGatewayMock).not.toHaveBeenCalled();
});
