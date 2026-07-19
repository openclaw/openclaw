// Subagent spawn workspace tests cover same-agent inheritance, cross-agent
// workspace selection, sandboxed cwd rejection, and cleanup deletion calls.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSubagentSpawnTestConfig,
  loadSubagentSpawnModuleForTest,
  setupAcceptedSubagentGatewayMock,
} from "./subagent-spawn.test-helpers.js";

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
type TestBindingRequest = {
  targetSessionKey: string;
  targetKind?: string;
  conversation: {
    channel: string;
    accountId?: string;
    conversationId: string;
    parentConversationId?: string;
  };
  placement: "current" | "child";
  metadata?: Record<string, unknown>;
};

const hoisted = vi.hoisted(() => ({
  callGatewayMock: vi.fn(),
  configOverride: {} as Record<string, unknown>,
  registerSubagentRunMock: vi.fn(),
  updateSessionStoreMock: vi.fn(),
  resolveSandboxRuntimeStatusMock: vi.fn<
    (params: { sessionKey?: string }) => { sandboxed: boolean }
  >(() => ({ sandboxed: false })),
  hookRunner: {
    hasHooks: vi.fn(() => false),
  },
  bindingService: {
    getCapabilities: vi.fn(() => ({
      adapterAvailable: true,
      bindSupported: true,
      placements: ["child"] as Array<"current" | "child">,
    })),
    bind: vi.fn(async (request: TestBindingRequest) => {
      const conversation = request.conversation;
      return {
        targetSessionKey: request.targetSessionKey,
        targetKind: request.targetKind,
        status: "active",
        conversation,
      };
    }),
    listBySession: vi.fn(() => []),
  },
}));

let spawnSubagentDirect: typeof import("./subagent-spawn.js").spawnSubagentDirect;
let resetSubagentRegistryForTests: typeof import("./subagent-registry.test-helpers.js").resetSubagentRegistryForTests;
let persistedStore: Record<string, Record<string, unknown>> = {};

function createConfigOverride(overrides?: Record<string, unknown>) {
  return createSubagentSpawnTestConfig("/tmp/workspace-main", {
    agents: {
      list: [
        {
          id: "main",
          workspace: "/tmp/workspace-main",
        },
      ],
    },
    session: {
      threadBindings: {
        defaultSpawnContext: "isolated",
      },
    },
    ...overrides,
  });
}

function resolveTestAgentConfig(cfg: Record<string, unknown>, agentId: string) {
  return (cfg as TestConfig).agents?.list?.find((entry) => entry.id === agentId);
}

function resolveTestAgentWorkspace(cfg: Record<string, unknown>, agentId: string) {
  return resolveTestAgentConfig(cfg, agentId)?.workspace ?? `/tmp/workspace-${agentId}`;
}

function getRegisteredRun() {
  return hoisted.registerSubagentRunMock.mock.calls.at(0)?.[0] as
    | Record<string, unknown>
    | undefined;
}

function findLastSessionDeleteCall() {
  return hoisted.callGatewayMock.mock.calls.findLast(
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
}

async function expectAcceptedWorkspace(params: { agentId: string; expectedWorkspaceDir: string }) {
  // Registered run workspace is the canonical child workspace; gateway params
  // should not receive ad hoc workspace overrides for native subagent calls.
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
  expect(getRegisteredRun()?.workspaceDir).toBe(params.expectedWorkspaceDir);
}

describe("spawnSubagentDirect workspace inheritance", () => {
  beforeAll(async () => {
    ({ resetSubagentRegistryForTests, spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({
      callGatewayMock: hoisted.callGatewayMock,
      getRuntimeConfig: () => hoisted.configOverride,
      registerSubagentRunMock: hoisted.registerSubagentRunMock,
      updateSessionStoreMock: hoisted.updateSessionStoreMock,
      hookRunner: hoisted.hookRunner,
      resolveAgentConfig: resolveTestAgentConfig,
      resolveAgentWorkspaceDir: resolveTestAgentWorkspace,
      resolveSandboxRuntimeStatus: hoisted.resolveSandboxRuntimeStatusMock,
      getSessionBindingService: () => hoisted.bindingService,
      resetModules: false,
    }));
  });

  beforeEach(() => {
    resetSubagentRegistryForTests();
    hoisted.callGatewayMock.mockClear();
    hoisted.registerSubagentRunMock.mockClear();
    persistedStore = {};
    hoisted.updateSessionStoreMock.mockReset();
    hoisted.updateSessionStoreMock.mockImplementation(
      async (
        _storePath: string,
        mutator: (store: Record<string, Record<string, unknown>>) => unknown,
      ) => {
        await mutator(persistedStore);
        return persistedStore;
      },
    );
    hoisted.resolveSandboxRuntimeStatusMock.mockReset();
    hoisted.resolveSandboxRuntimeStatusMock.mockImplementation(() => ({ sandboxed: false }));
    hoisted.hookRunner.hasHooks.mockReset();
    hoisted.hookRunner.hasHooks.mockImplementation(() => false);
    hoisted.bindingService.getCapabilities.mockClear();
    hoisted.bindingService.bind.mockClear();
    hoisted.bindingService.listBySession.mockClear();
    hoisted.configOverride = createConfigOverride();
    setupAcceptedSubagentGatewayMock(hoisted.callGatewayMock);
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

  it("uses explicit cwd for cross-agent native subagent spawns without leaking it to Gateway params", async () => {
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

    const result = await spawnSubagentDirect(
      {
        task: "inspect explicit cwd",
        agentId: "ops",
        cwd: "/tmp/requester-workspace",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "telegram",
        agentAccountId: "123",
        agentTo: "456",
        workspaceDir: "/tmp/fallback-requester-workspace",
      },
    );

    expect(result.status, JSON.stringify(result)).toBe("accepted");
    expect(getRegisteredRun()?.workspaceDir).toBe("/tmp/workspace-ops");
    const agentCall = hoisted.callGatewayMock.mock.calls.find(
      ([request]) => (request as { method?: string }).method === "agent",
    )?.[0] as { params?: Record<string, unknown> } | undefined;
    expect(agentCall?.params).not.toHaveProperty("workspaceDir");
  });

  it("binds a native child to an isolated descendant workspace", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-child-root-"));
    const isolated = path.join(root, ".fleet-runs", "run-1");
    await fs.mkdir(path.join(isolated, "skills", "assigned"), { recursive: true });
    hoisted.configOverride = createConfigOverride({
      agents: { list: [{ id: "main", workspace: root }] },
    });

    const result = await spawnSubagentDirect(
      { task: "inspect assigned skills", workspace: isolated, cwd: isolated },
      { agentSessionKey: "agent:main:main", workspaceDir: root },
    );

    const isolatedRealPath = await fs.realpath(isolated);
    expect(result.status, JSON.stringify(result)).toBe("accepted");
    expect(getRegisteredRun()?.workspaceDir).toBe(isolatedRealPath);
    const childEntry = Object.values(persistedStore).find(
      (entry) => entry.spawnedWorkspaceDir === isolatedRealPath,
    );
    expect(childEntry?.spawnedSkillsWorkspaceOnly).toBe(true);
  });

  it("rejects missing, outside, symlinked, and cwd-escaping workspace requests", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-child-root-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-child-outside-"));
    const isolated = path.join(root, "runs", "real");
    const linked = path.join(root, "runs", "linked");
    await fs.mkdir(isolated, { recursive: true });
    await fs.symlink(isolated, linked);
    hoisted.configOverride = createConfigOverride({
      agents: { list: [{ id: "main", workspace: root }] },
    });

    for (const workspace of [path.join(root, "missing"), outside, linked]) {
      const result = await spawnSubagentDirect(
        { task: "reject unsafe workspace", workspace },
        { agentSessionKey: "agent:main:main", workspaceDir: root },
      );
      expect(result.status).toBe("forbidden");
    }
    const escapedCwd = await spawnSubagentDirect(
      { task: "reject cwd escape", workspace: isolated, cwd: outside },
      { agentSessionKey: "agent:main:main", workspaceDir: root },
    );
    expect(escapedCwd).toMatchObject({
      status: "forbidden",
      error: "cwd must remain inside the requested child workspace",
    });
  });

  it("rejects explicit cwd overrides for sandboxed native subagent spawns", async () => {
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
    hoisted.resolveSandboxRuntimeStatusMock.mockImplementation(({ sessionKey }) => ({
      sandboxed: typeof sessionKey === "string" && sessionKey.includes(":subagent:"),
    }));

    const result = await spawnSubagentDirect(
      {
        task: "inspect explicit cwd",
        agentId: "ops",
        cwd: "/tmp/requester-workspace",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "telegram",
        agentAccountId: "123",
        agentTo: "456",
        workspaceDir: "/tmp/fallback-requester-workspace",
      },
    );

    expect(result.status).toBe("forbidden");
    expect(result.error).toContain("cwd override is not supported for sandboxed subagent runs");
    expect(hoisted.callGatewayMock).not.toHaveBeenCalled();
    expect(hoisted.registerSubagentRunMock).not.toHaveBeenCalled();
  });

  async function spawnAndReadAgentParams(task: { task: string; lightContext?: boolean }) {
    await spawnSubagentDirect(task, {
      agentSessionKey: "agent:main:main",
      agentChannel: "telegram",
      agentAccountId: "123",
      agentTo: "456",
      workspaceDir: "/tmp/requester-workspace",
    });

    const agentCall = hoisted.callGatewayMock.mock.calls.find(
      ([request]) => (request as { method?: string }).method === "agent",
    )?.[0] as { params?: Record<string, unknown> } | undefined;
    return agentCall?.params;
  }

  it("passes lightweight bootstrap context flags for lightContext subagent spawns", async () => {
    const agentParams = await spawnAndReadAgentParams({
      task: "inspect workspace",
      lightContext: true,
    });

    expect(agentParams?.bootstrapContextMode).toBe("lightweight");
    expect(agentParams?.bootstrapContextRunKind).toBe("default");
  });

  it("omits bootstrap context flags for default subagent spawns", async () => {
    const agentParams = await spawnAndReadAgentParams({
      task: "inspect workspace",
    });

    expect(agentParams).not.toHaveProperty("bootstrapContextMode");
    expect(agentParams).not.toHaveProperty("bootstrapContextRunKind");
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

    expect(result.status).toBe("error");
    expect(result.error).toBe("spawn startup failed");
    expect(result.childSessionKey).toMatch(/^agent:main:subagent:/);
    expect(hoisted.registerSubagentRunMock).not.toHaveBeenCalled();

    const deleteCall = findLastSessionDeleteCall();
    expect(deleteCall?.params?.key).toBe(result.childSessionKey);
    expect(deleteCall?.params?.deleteTranscript).toBe(true);
    expect(deleteCall?.params?.emitLifecycleHooks).toBe(false);
  });

  it("keeps lifecycle hooks enabled when registerSubagentRun fails after thread binding succeeds", async () => {
    hoisted.registerSubagentRunMock.mockImplementation(() => {
      throw new Error("registry unavailable");
    });
    hoisted.callGatewayMock.mockImplementation(
      async (request: {
        method?: string;
        params?: { key?: string; deleteTranscript?: boolean; emitLifecycleHooks?: boolean };
      }) => {
        if (request.method === "sessions.patch") {
          return { ok: true };
        }
        if (request.method === "agent") {
          return { runId: "run-thread-register-fail" };
        }
        if (request.method === "sessions.delete") {
          return { ok: true };
        }
        return {};
      },
    );

    const result = await spawnSubagentDirect(
      {
        task: "fail after register with thread binding",
        thread: true,
        mode: "session",
        context: "isolated",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "discord",
        agentAccountId: "acct-1",
        agentTo: "user-1",
        workspaceDir: "/tmp/requester-workspace",
      },
    );

    expect(result.status).toBe("error");
    expect(result.error).toBe("Failed to register subagent run: registry unavailable");
    expect(result.childSessionKey).toMatch(/^agent:main:subagent:/);
    expect(result.runId).toBe("run-thread-register-fail");

    const deleteCall = findLastSessionDeleteCall();
    expect(deleteCall?.params?.key).toBe(result.childSessionKey);
    expect(deleteCall?.params?.deleteTranscript).toBe(true);
    expect(deleteCall?.params?.emitLifecycleHooks).toBe(true);
  });
});
