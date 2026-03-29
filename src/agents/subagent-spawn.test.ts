import os from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSubagentSpawnTestConfig,
  expectPersistedRuntimeModel,
  installSessionStoreCaptureMock,
  loadSubagentSpawnModuleForTest,
} from "./subagent-spawn.test-helpers.js";
import { installAcceptedSubagentGatewayMock } from "./test-helpers/subagent-gateway.js";

const hoisted = vi.hoisted(() => ({
  callGatewayMock: vi.fn(),
  updateSessionStoreMock: vi.fn(),
  pruneLegacyStoreKeysMock: vi.fn(),
  registerSubagentRunMock: vi.fn(),
  emitSessionLifecycleEventMock: vi.fn(),
  configOverride: {} as Record<string, unknown>,
}));

let resetSubagentRegistryForTests: typeof import("./subagent-registry.js").resetSubagentRegistryForTests;
let spawnSubagentDirect: typeof import("./subagent-spawn.js").spawnSubagentDirect;

function createConfigOverride(overrides?: Record<string, unknown>) {
  return createSubagentSpawnTestConfig(os.tmpdir(), {
    agents: {
      defaults: {
        workspace: os.tmpdir(),
      },
      list: [
        {
          id: "main",
          workspace: "/tmp/workspace-main",
        },
      ],
    },
    ...overrides,
  });
}

describe("spawnSubagentDirect seam flow", () => {
  beforeEach(async () => {
    ({ resetSubagentRegistryForTests, spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({
      callGatewayMock: hoisted.callGatewayMock,
      loadConfig: () => hoisted.configOverride,
      updateSessionStoreMock: hoisted.updateSessionStoreMock,
      pruneLegacyStoreKeysMock: hoisted.pruneLegacyStoreKeysMock,
      registerSubagentRunMock: hoisted.registerSubagentRunMock,
      emitSessionLifecycleEventMock: hoisted.emitSessionLifecycleEventMock,
      resolveAgentConfig: () => undefined,
      resolveSubagentSpawnModelSelection: () => "openai-codex/gpt-5.4",
      resolveSandboxRuntimeStatus: () => ({ sandboxed: false }),
      sessionStorePath: "/tmp/subagent-spawn-session-store.json",
    }));
    resetSubagentRegistryForTests();
    hoisted.callGatewayMock.mockReset();
    hoisted.updateSessionStoreMock.mockReset();
    hoisted.pruneLegacyStoreKeysMock.mockReset();
    hoisted.registerSubagentRunMock.mockReset();
    hoisted.emitSessionLifecycleEventMock.mockReset();
    hoisted.configOverride = createConfigOverride();
    installAcceptedSubagentGatewayMock(hoisted.callGatewayMock);

    hoisted.updateSessionStoreMock.mockImplementation(
      async (
        _storePath: string,
        mutator: (store: Record<string, Record<string, unknown>>) => unknown,
      ) => {
        const store: Record<string, Record<string, unknown>> = {};
        await mutator(store);
        return store;
      },
    );
  });

  it("accepts a spawned run across session patching, runtime-model persistence, registry registration, and lifecycle emission", async () => {
    const operations: string[] = [];
    let persistedStore: Record<string, Record<string, unknown>> | undefined;

    hoisted.callGatewayMock.mockImplementation(async (request: { method?: string }) => {
      operations.push(`gateway:${request.method ?? "unknown"}`);
      if (request.method === "agent") {
        return { runId: "run-1" };
      }
      if (request.method?.startsWith("sessions.")) {
        return { ok: true };
      }
      return {};
    });
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock, {
      operations,
      onStore: (store) => {
        persistedStore = store;
      },
    });

    const result = await spawnSubagentDirect(
      {
        task: "inspect the spawn seam",
        model: "openai-codex/gpt-5.4",
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
      status: "accepted",
      runId: "run-1",
      mode: "run",
      modelApplied: true,
    });
    expect(result.childSessionKey).toMatch(/^agent:main:subagent:/);

    const childSessionKey = result.childSessionKey as string;
    expect(hoisted.pruneLegacyStoreKeysMock).toHaveBeenCalledTimes(1);
    expect(hoisted.updateSessionStoreMock).toHaveBeenCalledTimes(1);
    expect(hoisted.registerSubagentRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        childSessionKey,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "agent:main:main",
        requesterOrigin: {
          channel: "discord",
          accountId: "acct-1",
          to: "user-1",
          threadId: undefined,
        },
        task: "inspect the spawn seam",
        cleanup: "keep",
        model: "openai-codex/gpt-5.4",
        workspaceDir: "/tmp/requester-workspace",
        expectsCompletionMessage: true,
        spawnMode: "run",
      }),
    );
    expect(hoisted.emitSessionLifecycleEventMock).toHaveBeenCalledWith({
      sessionKey: childSessionKey,
      reason: "create",
      parentSessionKey: "agent:main:main",
      label: undefined,
    });

    expectPersistedRuntimeModel({
      persistedStore,
      sessionKey: childSessionKey,
      provider: "openai-codex",
      model: "gpt-5.4",
    });
    expect(operations.indexOf("gateway:sessions.patch")).toBeGreaterThan(-1);
    expect(operations.indexOf("store:update")).toBeGreaterThan(
      operations.indexOf("gateway:sessions.patch"),
    );
    expect(operations.indexOf("gateway:agent")).toBeGreaterThan(operations.indexOf("store:update"));
  });

  it('rejects waitForCompletion when mode="session"', async () => {
    const result = await spawnSubagentDirect(
      {
        task: "session mode cannot block inline",
        mode: "session",
        thread: true,
        waitForCompletion: true,
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "discord",
      },
    );

    expect(result).toMatchObject({
      status: "error",
      error: 'waitForCompletion=true is only supported for mode="run".',
    });
    expect(hoisted.callGatewayMock).not.toHaveBeenCalled();
  });

  it("restores auto-announce when waitForCompletion receives unexpected wait status", async () => {
    const result = await spawnSubagentDirect(
      {
        task: "wait with malformed status",
        waitForCompletion: true,
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "discord",
      },
    );

    expect(result).toMatchObject({
      status: "accepted",
      runId: "run-1",
      completion: {
        status: "error",
        error: "unexpected agent.wait status: undefined",
      },
    });
  });

  it("restores auto-announce when waitForCompletion returns error status", async () => {
    hoisted.callGatewayMock.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent") {
        return { runId: "run-1" };
      }
      if (request.method === "agent.wait") {
        return { status: "error", error: "run failed" };
      }
      if (request.method?.startsWith("sessions.")) {
        return { ok: true };
      }
      return {};
    });

    const result = await spawnSubagentDirect(
      {
        task: "wait returns error status",
        waitForCompletion: true,
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "discord",
      },
    );

    expect(result).toMatchObject({
      status: "accepted",
      runId: "run-1",
      completion: {
        status: "error",
        error: "run failed",
      },
    });
  });

  it("keeps waitForCompletion successful when reply capture fails", async () => {
    hoisted.callGatewayMock.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent") {
        return { runId: "run-1" };
      }
      if (request.method === "agent.wait") {
        return { status: "ok" };
      }
      if (request.method === "chat.history") {
        throw new Error("history unavailable");
      }
      if (request.method?.startsWith("sessions.")) {
        return { ok: true };
      }
      return {};
    });

    const result = await spawnSubagentDirect(
      {
        task: "wait returns ok but history lookup fails",
        waitForCompletion: true,
        cleanup: "delete",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "discord",
      },
    );

    expect(result).toMatchObject({
      status: "accepted",
      runId: "run-1",
      completion: {
        status: "ok",
        error: "failed to capture completion reply: history unavailable",
      },
    });
    expect(result.completion?.reply).toBeUndefined();
    expect(hoisted.callGatewayMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        method: "sessions.delete",
      }),
    );
  });

  it("deletes delete-cleanup child session after inline reply capture", async () => {
    const methods: string[] = [];
    hoisted.callGatewayMock.mockImplementation(async (request: { method?: string }) => {
      methods.push(request.method ?? "unknown");
      if (request.method === "agent") {
        return { runId: "run-1" };
      }
      if (request.method === "agent.wait") {
        return { status: "ok" };
      }
      if (request.method === "chat.history") {
        return {
          messages: [{ role: "assistant", content: "final result" }],
        };
      }
      if (request.method?.startsWith("sessions.")) {
        return { ok: true };
      }
      return {};
    });

    const result = await spawnSubagentDirect(
      {
        task: "wait returns ok and should cleanup delete after capture",
        waitForCompletion: true,
        cleanup: "delete",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "discord",
      },
    );

    expect(result).toMatchObject({
      status: "accepted",
      runId: "run-1",
      completion: {
        status: "ok",
        reply: "final result",
      },
    });

    const captureIdx = methods.indexOf("chat.history");
    const deleteIdx = methods.lastIndexOf("sessions.delete");
    expect(captureIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeGreaterThan(captureIdx);
  });
});
