// Subagent spawn model-session tests verify runtime model metadata is persisted
// before a child agent run starts.
import os from "node:os";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSubagentSpawnTestConfig,
  expectPersistedRuntimeModel,
  installSessionStoreCaptureMock,
  loadSubagentSpawnModuleForTest,
  setupAcceptedSubagentGatewayMock,
} from "./subagent-spawn.test-helpers.js";

const callGatewayMock = vi.fn();
const updateSessionStoreMock = vi.fn();
const pruneLegacyStoreKeysMock = vi.fn();

let resetSubagentRegistryForTests: typeof import("./subagent-registry.js").resetSubagentRegistryForTests;
let spawnSubagentDirect: typeof import("./subagent-spawn.js").spawnSubagentDirect;

describe("spawnSubagentDirect runtime model persistence", () => {
  beforeAll(async () => {
    ({ resetSubagentRegistryForTests, spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({
      callGatewayMock,
      getRuntimeConfig: () => createSubagentSpawnTestConfig(os.tmpdir()),
      updateSessionStoreMock,
      pruneLegacyStoreKeysMock,
      workspaceDir: os.tmpdir(),
    }));
  });

  beforeEach(() => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    updateSessionStoreMock.mockReset();
    pruneLegacyStoreKeysMock.mockReset();
    setupAcceptedSubagentGatewayMock(callGatewayMock);

    updateSessionStoreMock.mockImplementation(
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

  it("persists runtime model fields on the child session before starting the run", async () => {
    // The child run reads model/provider from session state, so persistence must
    // happen before the gateway accepts the agent request.
    const operations: string[] = [];
    callGatewayMock.mockImplementation(async (opts: { method?: string }) => {
      operations.push(`gateway:${opts.method ?? "unknown"}`);
      if (opts.method === "sessions.patch") {
        return { ok: true };
      }
      if (opts.method === "agent") {
        return { runId: "run-1", status: "accepted", acceptedAt: 1000 };
      }
      if (opts.method === "sessions.delete") {
        return { ok: true };
      }
      return {};
    });
    let persistedStore: Record<string, Record<string, unknown>> | undefined;
    installSessionStoreCaptureMock(updateSessionStoreMock, {
      operations,
      onStore: (store) => {
        persistedStore = store;
      },
    });

    const result = await spawnSubagentDirect(
      {
        task: "test",
        model: "openai/gpt-5.4",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "guildchat",
      },
    );

    expect(result.status).toBe("accepted");
    expect(result.modelApplied).toBe(true);
    expect(result.resolvedModel).toBe("openai/gpt-5.4");
    expect(result.resolvedProvider).toBe("openai");
    expect(updateSessionStoreMock).toHaveBeenCalledTimes(3);
    expectPersistedRuntimeModel({
      persistedStore,
      sessionKey: /^agent:main:subagent:/,
      provider: "openai",
      model: "gpt-5.4",
      overrideSource: "user",
    });
    expect(pruneLegacyStoreKeysMock).toHaveBeenCalledTimes(3);
    expect(operations.indexOf("store:update")).toBeGreaterThan(-1);
    expect(operations.indexOf("gateway:agent")).toBeGreaterThan(
      operations.lastIndexOf("store:update"),
    );
  });

  it("persists self-origin metadata for auto-selected subagent models", async () => {
    const dedicatedUpdateSessionStoreMock = vi.fn();
    const {
      resetSubagentRegistryForTests: resetForAutoModelTest,
      spawnSubagentDirect: spawnWithAutoModel,
    } = await loadSubagentSpawnModuleForTest({
      callGatewayMock,
      getRuntimeConfig: () =>
        createSubagentSpawnTestConfig(os.tmpdir(), {
          agents: {
            defaults: {
              workspace: os.tmpdir(),
              model: { primary: "openai/gpt-5.5" },
              subagents: { model: "gpt-5.4" },
            },
          },
        }),
      updateSessionStoreMock: dedicatedUpdateSessionStoreMock,
      pruneLegacyStoreKeysMock,
      workspaceDir: os.tmpdir(),
    });
    resetForAutoModelTest();
    let persistedStore: Record<string, Record<string, unknown>> | undefined;
    installSessionStoreCaptureMock(dedicatedUpdateSessionStoreMock, {
      onStore: (store) => {
        persistedStore = store;
      },
    });

    const result = await spawnWithAutoModel(
      {
        task: "test",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "guildchat",
      },
    );

    expect(result.status).toBe("accepted");
    const [, persistedEntry] = Object.entries(persistedStore ?? {})[0] ?? [];
    expect(persistedEntry?.modelOverrideSource).toBe("auto");
    expect(persistedEntry?.modelOverrideFallbackOriginProvider).toBe("openai");
    expect(persistedEntry?.modelOverrideFallbackOriginModel).toBe("gpt-5.4");
  });

  it("forwards resolved model to the agent gateway call so the child run uses the correct model (#91171)", async () => {
    // In-process spawn must include the resolved model in the agent gateway
    // params so the agent handler authorizes and applies the override.
    // Without this, the child run silently falls back to the default model.
    const agentCallParams: Array<Record<string, unknown>> = [];
    const dispatchedMethods: string[] = [];
    const forwardDispatchMock = vi.fn(async (...args: unknown[]) => {
      const method = args[0] as string;
      const params = args[1] as Record<string, unknown>;
      dispatchedMethods.push(method);
      if (method === "agent") {
        agentCallParams.push(params);
      }
      if (method === "sessions.patch" || method === "sessions.delete") {
        return { ok: true };
      }
      return { runId: "run-forward", status: "accepted", acceptedAt: Date.now() };
    });
    const forwardPruneMock = vi.fn();
    const forwardUpdateSessionStoreMock = vi.fn();
    installSessionStoreCaptureMock(forwardUpdateSessionStoreMock);
    const {
      resetSubagentRegistryForTests: resetForForwardTest,
      spawnSubagentDirect: spawnForForward,
    } = await loadSubagentSpawnModuleForTest({
      callGatewayMock,
      dispatchGatewayMethodInProcessMock: forwardDispatchMock,
      hasInProcessGatewayContextMock: () => true,
      getRuntimeConfig: () => createSubagentSpawnTestConfig(os.tmpdir()),
      updateSessionStoreMock: forwardUpdateSessionStoreMock,
      pruneLegacyStoreKeysMock: forwardPruneMock,
      workspaceDir: os.tmpdir(),
    });
    resetForForwardTest();

    const result = await spawnForForward(
      {
        task: "verify model forwarding",
        model: "qwen/qwen3.6-plus",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "guildchat",
      },
    );

    expect(result.status).toBe("accepted");
    expect(result.resolvedModel).toBe("qwen/qwen3.6-plus");
    expect(dispatchedMethods).toContain("agent");
    const agentParams = agentCallParams[0];
    expect(agentParams).toBeDefined();
    expect(agentParams.model).toBe("qwen/qwen3.6-plus");
  });
});
