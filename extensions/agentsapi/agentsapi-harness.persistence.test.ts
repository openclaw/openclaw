import path from "node:path";
import type { Turn } from "openai/resources/beta/agents/sessions/turns";
import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { AuthStorage, ModelRegistry } from "openclaw/plugin-sdk/agent-sessions";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentsApiBinding } from "./agentsapi-bindings.js";
import { AgentsApiClient } from "./agentsapi-client.js";
import plugin from "./index.js";

const { createSession } = vi.hoisted(() => ({
  createSession: vi.fn<typeof import("./agentsapi-session.js").createAgentsApiSession>(),
}));

// The provider turn, instructions, and transfers are separate contracts. Keep the
// registered harness, host generation, binding lifecycle, and SQLite stores real.
vi.mock("./agentsapi-session.js", () => ({ createAgentsApiSession: createSession }));
vi.mock("./agentsapi-prompt.js", () => ({
  buildAgentsApiInstructions: async () => "Fixture instructions",
  buildAgentsApiTurnContext: () => "",
}));
vi.mock("./agentsapi-files.js", () => ({
  prepareInputs: async () => ({ files: [], mappingText: "" }),
  uploadInputs: async () => {},
  collectOutputs: async () => [],
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: () => {
    throw new Error("Unexpected live request in the Agents API persistence fixture");
  },
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, "timeout").mockImplementation(() => new AbortController().signal);
  createSession.mockImplementation((options) => {
    const turn = completedTurn(options.sessionId);
    return {
      isAvailable: () => false,
      isSettled: () => true,
      wasSubmitted: () => true,
      queueMessage: async () => {},
      readUsageTurns: async () => [],
      run: async (prompt, persistInput, onSubmitted) => {
        await persistInput();
        await options.client.message(options.sessionId, prompt, options.signal);
        onSubmitted();
        options.onSettled?.();
        return { turn, cancelled: false, terminatedByTool: false };
      },
      close: async () => {},
      reconcileAfterClose: async () => turn,
    };
  });
});

afterEach(() => {
  createSession.mockReset();
  resetPluginStateStoreForTests();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("reopens an existing hosted binding and requires reset before persisting a fresh self-hosted session", async () => {
  await withOpenClawTestState({ label: "agentsapi-binding-persistence" }, async (state) => {
    const params = await createAttempt(state.stateDir);
    const storeOptions = {
      namespace: "agentsapi-sessions",
      maxEntries: 100_000,
      overflowPolicy: "reject-new" as const,
      env: state.env,
    };
    const openStore = () =>
      createPluginStateKeyedStoreForTests<AgentsApiBinding>("agentsapi", storeOptions);
    // Captured pre-environment-setting identity: SHA-256 of the JSON array
    // ["fixture-model", "fixture-not-a-real-api-key"].
    const hosted = {
      sessionId: "persisted-hosted-session",
      authFingerprint: "3c26b68488ce497a69d2c9fce9ee19c461fa67a3d959b0dc3bafe5718c56119d",
    };
    await openStore().register(params.sessionId, hosted);
    await reopenState();

    const create = vi
      .spyOn(AgentsApiClient.prototype, "create")
      .mockResolvedValue("fresh-self-hosted-session");
    const update = vi
      .spyOn(AgentsApiClient.prototype, "updateSettings")
      .mockResolvedValue(undefined);
    const message = vi.spyOn(AgentsApiClient.prototype, "message").mockResolvedValue(undefined);
    vi.spyOn(AgentsApiClient.prototype, "items").mockResolvedValue([]);
    let config: OpenClawConfig = {};
    const runtime = createPluginRuntimeMock({ config: { current: () => config } });
    runtime.state.openKeyedStore = <T>(
      options: Parameters<typeof runtime.state.openKeyedStore>[0],
    ) => createPluginStateKeyedStoreForTests<T>("agentsapi", { ...options, env: state.env });
    runtime.state.openSyncKeyedStore = <T>(
      options: Parameters<typeof runtime.state.openSyncKeyedStore>[0],
    ) => createPluginStateSyncKeyedStoreForTests<T>("agentsapi", { ...options, env: state.env });
    const register = () => {
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
    };
    let harness = register();
    try {
      expect(await harness.runAttempt(params)).toEqual(
        expect.objectContaining({ terminal: { kind: "ok" } }),
      );
      expect(await openStore().lookup(params.sessionId)).toEqual(hosted);
      expect(message).toHaveBeenCalledExactlyOnceWith(
        hosted.sessionId,
        params.prompt,
        expect.any(AbortSignal),
      );
      expect(create).toHaveBeenCalledTimes(0);

      config = { plugins: { entries: { agentsapi: { config: { environment: "self_hosted" } } } } };
      const rejected = await harness.runAttempt({ ...params, runId: "switched-run" });
      expect(rejected).toMatchObject({
        terminal: {
          kind: "failed",
          error: expect.objectContaining({
            message:
              "Agents API model, credential, environment, MCP configuration, or response verbosity changed; reset the OpenClaw session before continuing",
          }),
        },
      });
      expect([
        create.mock.calls.length,
        update.mock.calls.length,
        message.mock.calls.length,
      ]).toEqual([0, 1, 1]);
      expect(await openStore().lookup(params.sessionId)).toEqual(hosted);

      await harness.reset({ sessionId: params.sessionId, reason: "reset" });
      await harness.dispose();
      await reopenState();
      harness = register();
      expect(await harness.runAttempt({ ...params, runId: "reset-run" })).toEqual(
        expect.objectContaining({ terminal: { kind: "ok" } }),
      );
      expect(create).toHaveBeenCalledExactlyOnceWith(
        expect.any(AbortSignal),
        "Fixture instructions",
        "fixture-model",
        expect.objectContaining({
          environment: { type: "self_hosted", workspace_directory: params.workspaceDir },
        }),
      );
      const fresh = await openStore().lookup(params.sessionId);
      expect(fresh).toMatchObject({
        sessionId: "fresh-self-hosted-session",
        authFingerprint: expect.any(String),
      });
      await harness.dispose();
      await reopenState();
      expect(await openStore().lookup(params.sessionId)).toEqual(fresh);
      harness = register();
      expect(await harness.runAttempt({ ...params, runId: "reopened-self-hosted-run" })).toEqual(
        expect.objectContaining({ terminal: { kind: "ok" } }),
      );
      expect(create).toHaveBeenCalledTimes(1);
      expect(message.mock.calls.map(([sessionId]) => sessionId)).toEqual([
        hosted.sessionId,
        "fresh-self-hosted-session",
        "fresh-self-hosted-session",
      ]);
    } finally {
      await harness.dispose();
    }
  });
});

async function reopenState() {
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
}

async function createAttempt(stateDir: string): Promise<AgentHarnessAttemptParamsV2> {
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
    model: {
      id: "fixture-model",
      name: "Fixture Model",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1024,
      maxTokens: 512,
    },
    resolvedApiKey: "fixture-not-a-real-api-key",
    authStorage,
    modelRegistry: ModelRegistry.inMemory(authStorage),
    authProfileStore: { version: 1, profiles: {} },
    thinkLevel: "off",
    hostCapabilities: {
      kind: "agent-harness-host-capability",
      version: 1,
      assertActive: () => {},
      createToolSurface: () => [],
      bindToolSurface: (tools) => tools,
      runBeforeToolCall: async (request) => ({ blocked: false, params: request.params }),
      requestApproval: async () => undefined,
      waitForApproval: async () => undefined,
    },
  };
}

function completedTurn(sessionId: string): Turn {
  return {
    id: `turn-${sessionId}`,
    agent_id: "fixture-agent",
    session_id: sessionId,
    object: "agent.session.turn",
    created_at: 1,
    started_at: 1,
    completed_at: 2,
    status: "completed",
    subagent_id: null,
    error: null,
    usage: null,
  };
}
