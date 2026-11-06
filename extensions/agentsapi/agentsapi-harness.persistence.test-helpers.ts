import path from "node:path";
import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
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
import type { StoredBinding } from "./agentsapi-binding-record.js";
import type { AgentsApiBinding } from "./agentsapi-bindings.js";
import { AgentsApiClient } from "./agentsapi-client.js";
import { createAgentsApiHarness } from "./agentsapi-harness.js";
import { createHostedSession } from "./agentsapi.test-support.js";

export function registerHarness(
  env: NodeJS.ProcessEnv,
  readConfig: () => OpenClawConfig = () => ({}),
) {
  return createHarnessFixture(createBindingRuntime(env, readConfig));
}

export function createBindingStore<T = StoredBinding>(env: NodeJS.ProcessEnv) {
  return createPluginStateKeyedStoreForTests<T>("agentsapi", {
    namespace: "agentsapi-sessions",
    maxEntries: 100_000,
    overflowPolicy: "reject-new",
    env,
  });
}

export async function externalSessionFixture(state: { stateDir: string; env: NodeJS.ProcessEnv }) {
  const params = await createAttempt(state.stateDir);
  const runtime = createBindingRuntime(state.env, () => ({
    plugins: { entries: { agentsapi: { config: { environment: "self_hosted" } } } },
  }));
  const events: string[] = [];
  const hostedSession = createHostedSession("idle");
  const nativeSession: Awaited<ReturnType<AgentsApiClient["session"]>> = {
    ...hostedSession,
    id: "native-executor-session",
    environment: {
      id: "executor-environment",
      type: "self_hosted",
      capability_directories: [],
      workspace_directory: "/executor/project",
      remote_url: "wss://executor.example.test/session",
    },
  };
  const client = mockClient(nativeSession.id);
  client.session.mockResolvedValue(nativeSession);
  return {
    params,
    runtime,
    openStore: <T = AgentsApiBinding>() => createBindingStore<T>(state.env),
    nativeSession,
    ...client,
    cancel: vi.spyOn(AgentsApiClient.prototype, "cancel").mockImplementation(async () => {
      events.push("cancel");
    }),
    events,
    createHarness: () => createHarnessFixture(runtime),
  };
}

function createHarnessFixture(runtime: PluginRuntime) {
  const harness = createAgentsApiHarness(runtime);
  assert(
    typeof harness.runAttempt === "function" &&
      typeof harness.reset === "function" &&
      typeof harness.withSessionDeletion === "function" &&
      typeof harness.withSessionContextReset === "function" &&
      typeof harness.dispose === "function",
    "The Agents API harness requires run, reset, deletion, context reset, and disposal",
  );
  type Mutation = Parameters<typeof withNativeSessionMutationForTest>[0];
  const mutationHook =
    (hook: Mutation["hook"]) => (target: Mutation["target"], run: Mutation["run"]) =>
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
