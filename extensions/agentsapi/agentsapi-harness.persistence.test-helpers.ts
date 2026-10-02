import path from "node:path";
import type {
  AgentExecutorController,
  AgentHarnessAttemptParamsV2,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import * as harnessRuntime from "openclaw/plugin-sdk/agent-harness-runtime";
import { AuthStorage, ModelRegistry } from "openclaw/plugin-sdk/agent-sessions";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { vi } from "vitest";
import type { AgentsApiBinding } from "./agentsapi-bindings.js";
import { AgentsApiClient } from "./agentsapi-client.js";
import { createModel } from "./agentsapi.test-support.js";
import plugin from "./index.js";

export function registerHarness(
  env: NodeJS.ProcessEnv,
  readConfig: () => OpenClawConfig = () => ({}),
) {
  const runtime = createBindingRuntime(env, readConfig);
  const registerAgentHarness = vi.fn<OpenClawPluginApi["registerAgentHarness"]>();
  plugin.register(createTestPluginApi({ id: "agentsapi", runtime, registerAgentHarness }));
  const harness = registerAgentHarness.mock.calls[0]?.[0];
  if (!harness?.runAttempt || !harness.reset || !harness.dispose) {
    throw new Error("The registered Agents API harness requires run, reset, and disposal");
  }
  return {
    runAttempt: harness.runAttempt.bind(harness),
    reset: harness.reset.bind(harness),
    dispose: harness.dispose.bind(harness),
  };
}

export async function executorFixture(state: { stateDir: string; env: NodeJS.ProcessEnv }) {
  const params = await createAttempt(state.stateDir);
  const runtime = createBindingRuntime(state.env, () => ({
    plugins: {
      entries: {
        agentsapi: {
          config: { environment: "self_hosted", executorController: "fixture-executor" },
        },
      },
    },
  }));
  const openStore = () =>
    createPluginStateKeyedStoreForTests<AgentsApiBinding>("agentsapi", {
      namespace: "agentsapi-sessions",
      maxEntries: 100_000,
      overflowPolicy: "reject-new",
      env: state.env,
    });
  const events: string[] = [];
  const controller = {
    workspaceDirectory: "/executor/project",
    ensure: vi.fn<AgentExecutorController["ensure"]>(async () => {}),
    retire: vi.fn<AgentExecutorController["retire"]>(async () => {
      events.push("retire");
    }),
  };
  const resolveController = vi
    .spyOn(harnessRuntime, "resolveAgentExecutorController")
    .mockImplementation((pluginId) => {
      if (pluginId !== "fixture-executor") {
        throw new Error(
          `Agent executor controller plugin "${pluginId}" is missing, disabled, or unavailable`,
        );
      }
      return controller;
    });
  const nativeSession: Awaited<ReturnType<AgentsApiClient["session"]>> = {
    id: "native-executor-session",
    agent: {
      id: "fixture-agent",
      instructions: "Fixture instructions",
      model: "fixture-model",
      multi_agent: { enabled: false, max_concurrent_subagents: null },
      name: null,
      reasoning: { effort: null, summary: null },
      service_tier: "auto",
      text: { format: { type: "text" }, verbosity: "medium" },
      tools: [],
    },
    created_at: 1,
    last_active_at: 2,
    metadata: {},
    object: "agent.session",
    status: "idle",
    error: null,
    usage: null,
    vault_ids: [],
    environment: {
      id: "executor-environment",
      type: "self_hosted",
      capability_directories: [],
      workspace_directory: "/executor/project",
      remote_url: "wss://executor.example.test/session",
    },
    required_actions: [],
  };
  const create = vi.spyOn(AgentsApiClient.prototype, "create").mockResolvedValue(nativeSession.id);
  const session = vi.spyOn(AgentsApiClient.prototype, "session").mockResolvedValue(nativeSession);
  const environment = vi
    .spyOn(AgentsApiClient.prototype, "environment")
    .mockResolvedValue(connectedEnvironment());
  const message = vi.spyOn(AgentsApiClient.prototype, "message").mockResolvedValue(undefined);
  vi.spyOn(AgentsApiClient.prototype, "cancel").mockImplementation(async () => {
    events.push("cancel");
  });
  vi.spyOn(AgentsApiClient.prototype, "setReasoningEffort").mockResolvedValue(undefined);
  vi.spyOn(AgentsApiClient.prototype, "items").mockResolvedValue([]);
  return {
    params,
    runtime,
    openStore,
    controller,
    nativeSession,
    create,
    session,
    environment,
    message,
    events,
    resolveController,
    createHarness: () => requireExecutorHarness(runtime),
  };
}

export function requireExecutorHarness(runtime: PluginRuntime) {
  const registerAgentHarness = vi.fn<OpenClawPluginApi["registerAgentHarness"]>();
  plugin.register(createTestPluginApi({ id: "agentsapi", runtime, registerAgentHarness }));
  const harness = registerAgentHarness.mock.calls[0]?.[0];
  if (!harness?.runAttempt || !harness.reset || !harness.withSessionDeletion || !harness.dispose) {
    throw new Error("The Agents API harness requires run, reset, deletion, and disposal");
  }
  return {
    runAttempt: harness.runAttempt.bind(harness),
    reset: harness.reset.bind(harness),
    withSessionDeletion: harness.withSessionDeletion,
    dispose: harness.dispose.bind(harness),
  };
}

function createBindingRuntime(env: NodeJS.ProcessEnv, current: () => OpenClawConfig) {
  const runtime = createPluginRuntimeMock({ config: { current } });
  runtime.state.openKeyedStore = <T>(options: Parameters<typeof runtime.state.openKeyedStore>[0]) =>
    createPluginStateKeyedStoreForTests<T>("agentsapi", { ...options, env });
  runtime.state.openSyncKeyedStore = <T>(
    options: Parameters<typeof runtime.state.openSyncKeyedStore>[0],
  ) => createPluginStateSyncKeyedStoreForTests<T>("agentsapi", { ...options, env });
  return runtime;
}

export function connectedEnvironment(): Awaited<ReturnType<AgentsApiClient["environment"]>> {
  return {
    id: "executor-environment",
    type: "self_hosted",
    status: "connected",
    object: "agent.environment",
    files: [],
    plugins: [],
    skills: [],
  };
}

export async function reopenState() {
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
}

export async function createAttempt(stateDir: string) {
  const target = {
    agentId: "main",
    sessionId: "local-persisted-session",
    sessionKey: "agent:main:persisted-session",
    storePath: path.join(stateDir, "openclaw-agent.sqlite"),
  };
  await upsertSessionEntry({
    ...target,
    entry: { sessionId: target.sessionId, updatedAt: Date.now() },
  });
  const authStorage = AuthStorage.inMemory();
  return {
    ...target,
    sessionTarget: target,
    sessionFile: path.join(stateDir, "session.jsonl"),
    workspaceDir: stateDir,
    agentDir: stateDir,
    config: {},
    runId: "persisted-run",
    prompt: "Continue the retained conversation.",
    timeoutMs: 5_000,
    provider: "openai",
    modelId: "fixture-model",
    model: createModel(),
    resolvedApiKey: "fixture-not-a-real-api-key",
    authStorage,
    modelRegistry: ModelRegistry.inMemory(authStorage),
    authProfileStore: { version: 1, profiles: {} },
    thinkLevel: "off",
    hostCapabilities: {
      kind: "agent-harness-host-capability",
      version: 1,
      assertActive: () => {},
      createToolSurfaceAsync: async () => [],
      bindToolSurface: (tools) => tools,
      runBeforeToolCall: async (request) => ({ blocked: false, params: request.params }),
      requestApproval: async () => undefined,
      waitForApproval: async () => undefined,
    },
  } satisfies AgentHarnessAttemptParamsV2;
}
