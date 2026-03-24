import { beforeEach, describe, expect, it, vi } from "vitest";
import { installAcceptedSubagentGatewayMock } from "./test-helpers/subagent-gateway.js";

type TestAgentConfig = {
  id?: string;
  workspace?: string;
  subagents?: {
    allowAgents?: string[];
  };
};

type TestConfig = {
  agents?: {
    list?: TestAgentConfig[];
  };
};

const hoisted = vi.hoisted(() => ({
  callGatewayMock: vi.fn(),
  configOverride: {} as Record<string, unknown>,
  registerSubagentRunMock: vi.fn(),
}));

let spawnSubagentDirect: typeof import("./subagent-spawn.js").spawnSubagentDirect;

vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => hoisted.callGatewayMock(opts),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => hoisted.configOverride,
  };
});

vi.mock("@mariozechner/pi-ai/oauth", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-ai/oauth")>(
    "@mariozechner/pi-ai/oauth",
  );
  return {
    ...actual,
    getOAuthApiKey: () => "",
    getOAuthProviders: () => [],
  };
});

vi.mock("./subagent-registry.js", () => ({
  countActiveRunsForSession: () => 0,
  registerSubagentRun: (args: unknown) => hoisted.registerSubagentRunMock(args),
}));

vi.mock("./subagent-announce.js", () => ({
  buildSubagentSystemPrompt: () => "system-prompt",
}));

vi.mock("./subagent-depth.js", () => ({
  getSubagentDepthFromSessionStore: () => 0,
}));

vi.mock("./model-selection.js", () => ({
  resolveSubagentSpawnModelSelection: () => undefined,
}));

vi.mock("./sandbox/runtime-status.js", () => ({
  resolveSandboxRuntimeStatus: () => ({ sandboxed: false }),
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => ({ hasHooks: () => false }),
}));

vi.mock("../utils/delivery-context.js", () => ({
  normalizeDeliveryContext: (value: unknown) => value,
}));

vi.mock("./tools/sessions-helpers.js", () => ({
  resolveMainSessionAlias: () => ({ mainKey: "main", alias: "main" }),
  resolveInternalSessionKey: ({ key }: { key?: string }) => key ?? "agent:main:main",
  resolveDisplaySessionKey: ({ key }: { key?: string }) => key ?? "agent:main:main",
}));

vi.mock("./agent-scope.js", () => ({
  resolveAgentConfig: (cfg: TestConfig, agentId: string) =>
    cfg.agents?.list?.find((entry) => entry.id === agentId),
  resolveAgentWorkspaceDir: (cfg: TestConfig, agentId: string) =>
    cfg.agents?.list?.find((entry) => entry.id === agentId)?.workspace ??
    `/tmp/workspace-${agentId}`,
}));

function createConfigOverride(overrides?: Record<string, unknown>) {
  return {
    session: {
      mainKey: "main",
      scope: "per-sender",
    },
    agents: {
      list: [
        {
          id: "main",
          workspace: "/tmp/workspace-main",
        },
      ],
    },
    ...overrides,
  };
}

function setupGatewayMock() {
  installAcceptedSubagentGatewayMock(hoisted.callGatewayMock);
}

async function loadFreshSubagentSpawnWorkspaceModuleForTest() {
  vi.resetModules();
  vi.doMock("../gateway/call.js", () => ({
    callGateway: (opts: unknown) => hoisted.callGatewayMock(opts),
  }));
  vi.doMock("../config/config.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../config/config.js")>();
    return {
      ...actual,
      loadConfig: () => hoisted.configOverride,
    };
  });
  vi.doMock("./subagent-registry.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./subagent-registry.js")>();
    return {
      ...actual,
      countActiveRunsForSession: () => 0,
      registerSubagentRun: (args: unknown) => hoisted.registerSubagentRunMock(args),
    };
  });
  vi.doMock("./subagent-announce.js", () => ({
    buildSubagentSystemPrompt: () => "system-prompt",
  }));
  vi.doMock("./subagent-depth.js", () => ({
    getSubagentDepthFromSessionStore: () => 0,
  }));
  vi.doMock("./model-selection.js", () => ({
    resolveSubagentSpawnModelSelection: () => undefined,
  }));
  vi.doMock("./sandbox/runtime-status.js", () => ({
    resolveSandboxRuntimeStatus: () => ({ sandboxed: false }),
  }));
  vi.doMock("../plugins/hook-runner-global.js", () => ({
    getGlobalHookRunner: () => ({ hasHooks: () => false }),
  }));
  vi.doMock("../utils/delivery-context.js", () => ({
    normalizeDeliveryContext: (value: unknown) => value,
  }));
  vi.doMock("./tools/sessions-helpers.js", () => ({
    resolveMainSessionAlias: () => ({ mainKey: "main", alias: "main" }),
    resolveInternalSessionKey: ({ key }: { key?: string }) => key ?? "agent:main:main",
    resolveDisplaySessionKey: ({ key }: { key?: string }) => key ?? "agent:main:main",
  }));
  vi.doMock("./agent-scope.js", () => ({
    resolveAgentConfig: (cfg: TestConfig, agentId: string) =>
      cfg.agents?.list?.find((entry) => entry.id === agentId),
    resolveAgentWorkspaceDir: (cfg: TestConfig, agentId: string) =>
      cfg.agents?.list?.find((entry) => entry.id === agentId)?.workspace ??
      `/tmp/workspace-${agentId}`,
  }));
  ({ spawnSubagentDirect } = await import("./subagent-spawn.js"));
}

function getRegisteredRun() {
  return hoisted.registerSubagentRunMock.mock.calls.at(0)?.[0] as
    | Record<string, unknown>
    | undefined;
}

async function expectAcceptedWorkspace(params: { agentId: string; expectedWorkspaceDir: string }) {
  const result = await spawnSubagentDirect(
    {
      task: "inspect workspace",
      agentId: params.agentId,
    },
    {
      agentSessionKey: "agent:main:main",
      agentChannel: "telegram",
      agentAccountId: "123",
      agentTo: "456",
      workspaceDir: "/tmp/requester-workspace",
    },
  );

  expect(result.status).toBe("accepted");
  expect(getRegisteredRun()).toMatchObject({
    workspaceDir: params.expectedWorkspaceDir,
  });
}

describe("spawnSubagentDirect workspace inheritance", () => {
  beforeEach(async () => {
    await loadFreshSubagentSpawnWorkspaceModuleForTest();
    hoisted.callGatewayMock.mockClear();
    hoisted.registerSubagentRunMock.mockClear();
    hoisted.configOverride = createConfigOverride();
    setupGatewayMock();
  });

  it("uses the target agent workspace for cross-agent spawns", async () => {
    hoisted.configOverride = createConfigOverride({
      agents: {
        list: [
          {
            id: "main",
            workspace: "/tmp/workspace-main",
            subagents: {
              allowAgents: ["ops"],
            },
          },
          {
            id: "ops",
            workspace: "/tmp/workspace-ops",
          },
        ],
      },
    });

    await expectAcceptedWorkspace({
      agentId: "ops",
      expectedWorkspaceDir: "/tmp/workspace-ops",
    });
  });

  it("preserves the inherited workspace for same-agent spawns", async () => {
    await expectAcceptedWorkspace({
      agentId: "main",
      expectedWorkspaceDir: "/tmp/requester-workspace",
    });
  });

  it("deletes the provisional child session when a non-thread subagent start fails", async () => {
    hoisted.callGatewayMock.mockImplementation(
      async (request: {
        method?: string;
        params?: { key?: string; deleteTranscript?: boolean; emitLifecycleHooks?: boolean };
      }) => {
        if (request.method === "sessions.patch") {
          return { ok: true };
        }
        if (request.method === "agent") {
          throw new Error("spawn startup failed");
        }
        if (request.method === "sessions.delete") {
          return { ok: true };
        }
        return {};
      },
    );

    const result = await spawnSubagentDirect(
      {
        task: "fail after provisional session creation",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "discord",
        agentAccountId: "acct-1",
        agentTo: "user-1",
        workspaceDir: "/tmp/requester-workspace",
      },
    );

    expect(result).toMatchObject({
      status: "error",
      error: "spawn startup failed",
    });
    expect(result.childSessionKey).toMatch(/^agent:main:subagent:/);
    expect(hoisted.registerSubagentRunMock).not.toHaveBeenCalled();

    const deleteCall = hoisted.callGatewayMock.mock.calls.find(
      ([request]) => (request as { method?: string }).method === "sessions.delete",
    )?.[0] as
      | {
          params?: {
            key?: string;
            deleteTranscript?: boolean;
            emitLifecycleHooks?: boolean;
          };
        }
      | undefined;

    expect(deleteCall?.params).toMatchObject({
      key: result.childSessionKey,
      deleteTranscript: true,
      emitLifecycleHooks: false,
    });
  });
});
