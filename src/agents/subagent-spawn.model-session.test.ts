// Subagent spawn model-session tests verify runtime model metadata is persisted
// before a child agent run starts.
import os from "node:os";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createSubagentSpawnTestConfig,
  expectPersistedRuntimeModel,
  installSessionStoreCaptureMock,
  loadSubagentSpawnModuleForTest,
  setupAcceptedSubagentGatewayMock,
} from "./subagent-spawn.test-helpers.js";

const callGatewayMock = vi.fn();
const updateSessionStoreMock = vi.fn();

let resetSubagentRegistryForTests: typeof import("./subagent-registry.test-helpers.js").resetSubagentRegistryForTests;
let spawnSubagentDirect: typeof import("./subagent-spawn.js").spawnSubagentDirect;

async function loadPolicySpawn(cfg: OpenClawConfig) {
  const callGateway = vi.fn();
  const updateSessionStore = vi.fn();
  const registerSubagentRun = vi.fn();
  const emitSessionLifecycleEvent = vi.fn();
  const loaded = await loadSubagentSpawnModuleForTest({
    callGatewayMock: callGateway,
    getRuntimeConfig: () => cfg,
    updateSessionStoreMock: updateSessionStore,
    registerSubagentRunMock: registerSubagentRun,
    emitSessionLifecycleEventMock: emitSessionLifecycleEvent,
    workspaceDir: os.tmpdir(),
  });
  loaded.resetSubagentRegistryForTests();
  setupAcceptedSubagentGatewayMock(callGateway);
  return {
    ...loaded,
    callGateway,
    updateSessionStore,
    registerSubagentRun,
    emitSessionLifecycleEvent,
  };
}

describe("spawnSubagentDirect runtime model persistence", () => {
  beforeAll(async () => {
    ({ resetSubagentRegistryForTests, spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({
      callGatewayMock,
      getRuntimeConfig: () => createSubagentSpawnTestConfig(os.tmpdir()),
      updateSessionStoreMock,
      workspaceDir: os.tmpdir(),
    }));
  });

  beforeEach(() => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    updateSessionStoreMock.mockReset();
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
    expect(updateSessionStoreMock).toHaveBeenCalledTimes(2);
    expectPersistedRuntimeModel({
      persistedStore,
      sessionKey: /^agent:main:subagent:/,
      provider: "openai",
      model: "gpt-5.4",
      overrideSource: "user",
    });
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
});

describe("spawnSubagentDirect explicit model policy preflight", () => {
  it("rejects a disallowed model before creating any durable child state", async () => {
    const cfg = createSubagentSpawnTestConfig(os.tmpdir(), {
      agents: {
        defaults: {
          workspace: os.tmpdir(),
          model: { primary: "openai/gpt-5.6-luna" },
          modelPolicy: { allow: ["openai/gpt-5.6-luna"] },
        },
      },
    }) as OpenClawConfig;
    const {
      spawnSubagentDirect: spawnWithPolicy,
      callGateway,
      updateSessionStore,
      registerSubagentRun,
      emitSessionLifecycleEvent,
    } = await loadPolicySpawn(cfg);

    const result = await spawnWithPolicy(
      { task: "reject disallowed model", model: "anthropic/claude-sonnet-4-6" },
      { agentSessionKey: "agent:main:main" },
    );

    expect(result).toEqual({
      status: "error",
      error: "model not allowed: anthropic/claude-sonnet-4-6",
    });
    expect(updateSessionStore).not.toHaveBeenCalled();
    expect(registerSubagentRun).not.toHaveBeenCalled();
    expect(emitSessionLifecycleEvent).not.toHaveBeenCalled();
    // No gateway agent launch means no child transcript or asynchronous task can start.
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("uses the target agent policy and persists the alias's canonical model ref", async () => {
    const cfg = createSubagentSpawnTestConfig(os.tmpdir(), {
      agents: {
        defaults: {
          workspace: os.tmpdir(),
          model: { primary: "openai/gpt-5.6-luna" },
          models: { "openai/gpt-5.6-luna": { alias: "approved" } },
          modelPolicy: { allow: ["approved"] },
        },
        list: [
          { id: "main", subagents: { allowAgents: ["worker"] } },
          {
            id: "worker",
            model: { primary: "anthropic/claude-sonnet-4-6" },
            models: { "anthropic/claude-sonnet-4-6": { alias: "approved" } },
            modelPolicy: { allow: ["approved"] },
          },
        ],
      },
    }) as OpenClawConfig;
    const {
      spawnSubagentDirect: spawnWithPolicy,
      callGateway,
      updateSessionStore,
    } = await loadPolicySpawn(cfg);
    let persistedStore: Record<string, Record<string, unknown>> | undefined;
    installSessionStoreCaptureMock(updateSessionStore, {
      onStore: (store) => {
        persistedStore = store;
      },
    });

    const result = await spawnWithPolicy(
      { task: "use target policy", agentId: "worker", model: "approved" },
      { agentSessionKey: "agent:main:main" },
    );

    expect(result).toMatchObject({
      status: "accepted",
      resolvedModel: "anthropic/claude-sonnet-4-6",
      resolvedProvider: "anthropic",
    });
    expectPersistedRuntimeModel({
      persistedStore,
      sessionKey: /^agent:worker:subagent:/,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      overrideSource: "user",
    });
    const agentCall = callGateway.mock.calls.find(([request]) => request.method === "agent")?.[0];
    expect(agentCall?.params).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
  });

  it.each([
    {
      name: "an explicit allow-any policy",
      defaults: { modelPolicy: { allow: [] } },
    },
    {
      name: "a provider wildcard policy",
      defaults: { modelPolicy: { allow: ["dynamic/*"] } },
    },
    {
      name: "an unmarked legacy model allowlist",
      defaults: { models: { "dynamic/new-model": {} } },
    },
  ])("accepts a dynamic ref under $name", async ({ defaults }) => {
    const cfg = createSubagentSpawnTestConfig(os.tmpdir(), {
      agents: { defaults: { workspace: os.tmpdir(), ...defaults } },
    }) as OpenClawConfig;
    const { spawnSubagentDirect: spawnWithPolicy, updateSessionStore } = await loadPolicySpawn(cfg);
    installSessionStoreCaptureMock(updateSessionStore);

    const result = await spawnWithPolicy(
      { task: "use dynamic model", model: "dynamic/new-model" },
      { agentSessionKey: "agent:main:main" },
    );

    expect(result).toMatchObject({
      status: "accepted",
      resolvedModel: "dynamic/new-model",
      resolvedProvider: "dynamic",
    });
  });

  it("leaves configured automatic model selection on the runtime validation path", async () => {
    const cfg = createSubagentSpawnTestConfig(os.tmpdir(), {
      agents: {
        defaults: {
          workspace: os.tmpdir(),
          model: { primary: "openai/gpt-5.6-luna" },
          subagents: { model: "anthropic/claude-sonnet-4-6" },
          modelPolicy: { allow: ["openai/gpt-5.6-luna"] },
        },
      },
    }) as OpenClawConfig;
    const { spawnSubagentDirect: spawnWithPolicy, updateSessionStore } = await loadPolicySpawn(cfg);
    installSessionStoreCaptureMock(updateSessionStore);

    const result = await spawnWithPolicy(
      { task: "use configured model" },
      { agentSessionKey: "agent:main:main" },
    );

    expect(result).toMatchObject({
      status: "accepted",
      resolvedModel: "anthropic/claude-sonnet-4-6",
      resolvedProvider: "anthropic",
    });
  });
});
