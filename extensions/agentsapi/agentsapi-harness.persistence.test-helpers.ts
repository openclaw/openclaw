import path from "node:path";
import type {
  AgentExecutorController,
  AgentHarnessAttemptParamsV2,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import * as harnessRuntime from "openclaw/plugin-sdk/agent-harness-runtime";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import {
  createPluginRuntimeMock,
  runInHarnessToolAuthorityForTest,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { setRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import {
  closeOpenClawStateDatabaseAsync,
  withNativeSessionMutationForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { assert, vi } from "vitest";
import { createAttemptParams } from "./agentsapi-attempt.test-helpers.js";
import type { AgentsApiBinding } from "./agentsapi-bindings.js";
import { AgentsApiClient } from "./agentsapi-client.js";
import { createHostedSession } from "./agentsapi.test-support.js";
import plugin from "./index.js";

export function registerHarness(
  env: NodeJS.ProcessEnv,
  readConfig: () => OpenClawConfig = () => ({}),
) {
  return requireExecutorHarness(createBindingRuntime(env, readConfig));
}

export async function executorFixture(state: { stateDir: string; env: NodeJS.ProcessEnv }) {
  const params = await createAttempt(state.stateDir);
  const config = { environment: "self_hosted", executorController: "fixture-executor" };
  const runtime = createBindingRuntime(state.env, () => ({
    plugins: { entries: { agentsapi: { config } } },
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
    ensure: vi.fn<AgentExecutorController["ensure"]>(async () => {
      nativeSession.status = "idle";
      nativeSession.required_actions = [];
    }),
    retire: vi.fn<AgentExecutorController["retire"]>(async () => {
      events.push("retire");
    }),
  };
  const resolveController = vi
    .spyOn(harnessRuntime, "resolveAgentExecutorController")
    .mockImplementation((pluginId) => {
      assert(pluginId === "fixture-executor", `Unknown fixture executor: ${pluginId}`);
      return controller;
    });
  const nativeSession: Awaited<ReturnType<AgentsApiClient["session"]>> = {
    ...createHostedSession("requires_action"),
    id: "native-executor-session",
    agent: { ...createHostedSession().agent, id: "fixture-agent" },
    environment: {
      id: "executor-environment",
      type: "self_hosted",
      capability_directories: [],
      workspace_directory: "/executor/project",
      remote_url: "wss://executor.example.test/session",
    },
    required_actions: [{ type: "environment_connection", environment_id: "executor-environment" }],
  };
  const client = mockClient(nativeSession.id);
  client.session.mockResolvedValue(nativeSession);
  const environment = vi
    .spyOn(AgentsApiClient.prototype, "environment")
    .mockResolvedValue(connectedEnvironment());
  const cancel = vi.spyOn(AgentsApiClient.prototype, "cancel").mockImplementation(async () => {
    events.push("cancel");
  });
  return {
    params,
    runtime,
    openStore,
    controller,
    nativeSession,
    ...client,
    environment,
    cancel,
    events,
    resolveController,
    createHarness: () => requireExecutorHarness(runtime),
  };
}

export function requireExecutorHarness(runtime: PluginRuntime) {
  const registerAgentHarness = vi.fn<OpenClawPluginApi["registerAgentHarness"]>();
  plugin.register(createTestPluginApi({ id: "agentsapi", runtime, registerAgentHarness }));
  const harness = registerAgentHarness.mock.calls[0]?.[0];
  assert(
    typeof harness?.runAttempt === "function" &&
      typeof harness.reset === "function" &&
      typeof harness.withSessionDeletion === "function" &&
      typeof harness.withSessionContextReset === "function" &&
      typeof harness.dispose === "function",
    "The Agents API harness requires run, reset, deletion, context reset, and disposal",
  );
  const mutationHook =
    (hook: "withSessionDeletion" | "withSessionContextReset") =>
    (
      target: Parameters<typeof withNativeSessionMutationForTest>[0]["target"],
      run: Parameters<typeof withNativeSessionMutationForTest>[0]["run"],
    ) =>
      withNativeSessionMutationForTest({ pluginId: "agentsapi", harness, hook, target, run });
  return {
    runAttempt: (params: AgentHarnessAttemptParamsV2) =>
      runInHarnessToolAuthorityForTest(params, "agentsapi", (admitted) =>
        harness.runAttempt(admitted),
      ),
    reset: harness.reset.bind(harness),
    withSessionDeletion: mutationHook("withSessionDeletion"),
    withSessionContextReset: mutationHook("withSessionContextReset"),
    dispose: harness.dispose.bind(harness),
  };
}

function createBindingRuntime(env: NodeJS.ProcessEnv, current: () => OpenClawConfig) {
  setRuntimeConfigSnapshot(current());
  const runtime = createPluginRuntimeMock({ config: { current } });
  runtime.state.openKeyedStoreV2 = <T>(
    options: Parameters<typeof runtime.state.openKeyedStoreV2>[0],
    authority?: Parameters<typeof runtime.state.openKeyedStoreV2>[1],
  ) => {
    const store = createPluginStateKeyedStoreForTests<T>("agentsapi", { ...options, env });
    return authority ? store.withCurrent(authority) : store;
  };
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
  const params = createAttemptParams();
  return {
    ...params,
    ...target,
    sessionTarget: target,
    sessionFile: path.join(stateDir, "session.jsonl"),
    workspaceDir: stateDir,
    agentDir: stateDir,
    config: {},
    runId: "persisted-run",
    prompt: "Continue the retained conversation.",
    timeoutMs: 5_000,
    resolvedApiKey: "fixture-not-a-real-api-key",
    hostCapabilities: { ...params.hostCapabilities, createToolSurfaceAsync: async () => [] },
  } satisfies AgentHarnessAttemptParamsV2;
}

export function mockClient(sessionId: string) {
  const session = vi
    .spyOn(AgentsApiClient.prototype, "session")
    .mockResolvedValue(createHostedSession("idle"));
  const create = vi.spyOn(AgentsApiClient.prototype, "create").mockResolvedValue(sessionId);
  const update = vi.spyOn(AgentsApiClient.prototype, "setReasoningEffort").mockResolvedValue();
  const message = vi.spyOn(AgentsApiClient.prototype, "message").mockResolvedValue();
  vi.spyOn(AgentsApiClient.prototype, "items").mockResolvedValue([]);
  return { create, update, message, session };
}
