import path from "node:path";
import type { Turn } from "openai/resources/beta/agents/sessions/turns";
import {
  AgentHarnessPreflightError,
  type AgentHarnessAttemptParamsV2,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { AuthStorage, ModelRegistry } from "openclaw/plugin-sdk/agent-sessions";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
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
import { createSandboxTestContext } from "openclaw/plugin-sdk/test-fixtures";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentsApiBinding } from "./agentsapi-bindings.js";
import { AgentsApiClient } from "./agentsapi-client.js";
import plugin from "./index.js";

const { createSession } = vi.hoisted(() => ({
  createSession: vi.fn<typeof import("./agentsapi-session.js").createAgentsApiSession>(),
}));

// Keep the registered harness, input formatting, host generation, binding lifecycle,
// SQLite stores, and input file preparation real; provider execution stays mocked.
vi.mock("./agentsapi-session.js", () => ({ createAgentsApiSession: createSession }));
vi.mock("./agentsapi-prompt.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agentsapi-prompt.js")>()),
  buildAgentsApiInstructions: async () => "Fixture instructions",
}));
vi.mock("./agentsapi-files.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agentsapi-files.js")>()),
  prepareSelfHostedInputs: async () => ({ files: [], mappingText: "" }),
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
      .spyOn(AgentsApiClient.prototype, "setReasoningEffort")
      .mockResolvedValue(undefined);
    const message = vi.spyOn(AgentsApiClient.prototype, "message").mockResolvedValue(undefined);
    vi.spyOn(AgentsApiClient.prototype, "items").mockResolvedValue([]);
    let config: OpenClawConfig = {};
    const register = () => registerHarness(state.env, () => config);
    let harness = register();
    try {
      expect(await harness.runAttempt(params)).toEqual(
        expect.objectContaining({ terminal: { kind: "ok" } }),
      );
      expect(await openStore().lookup(params.sessionId)).toEqual(hosted);
      expect(message).toHaveBeenCalledExactlyOnceWith(
        hosted.sessionId,
        expect.stringContaining(params.prompt),
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
              "Agents API model, credential, environment, or MCP configuration changed; reset the OpenClaw session before continuing",
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

it("continues image-bearing input and the following turn on the same native session", async () => {
  await withOpenClawTestState({ label: "agentsapi-image-recovery" }, async (state) => {
    const params = await createAttempt(state.stateDir);
    const create = vi.spyOn(AgentsApiClient.prototype, "create").mockResolvedValue("image-session");
    vi.spyOn(AgentsApiClient.prototype, "setReasoningEffort").mockResolvedValue(undefined);
    const message = vi.spyOn(AgentsApiClient.prototype, "message").mockResolvedValue(undefined);
    vi.spyOn(AgentsApiClient.prototype, "items").mockResolvedValue([]);
    const harness = registerHarness(state.env);
    try {
      const result = await harness.runAttempt({
        ...params,
        prompt: "Read the supplied image.",
        images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
      });
      expect(result).toMatchObject({ terminal: { kind: "ok" } });
      const input = message.mock.calls[0]![1];
      expect(input).toContain("Read the supplied image.");
      expect(input).toContain("The Agents API harness does not support inline image inputs.");
      expect(input).toContain("No original attachment files were transferred for this message.");
      expect(input).toContain("ask for a text description if the image is necessary");
      expect(await harness.runAttempt({ ...params, runId: "following-turn" })).toMatchObject({
        terminal: { kind: "ok" },
      });
      expect(message.mock.calls.map(([sessionId]) => sessionId)).toEqual([
        "image-session",
        "image-session",
      ]);
      expect(create).toHaveBeenCalledTimes(1);
    } finally {
      await harness.dispose();
    }
  });
});

it("transfers each turn's original image bytes to unique paths on the same hosted session", async () => {
  await withOpenClawTestState({ label: "agentsapi-original-images" }, async (state) => {
    const params = await createAttempt(state.stateDir);
    const create = vi.spyOn(AgentsApiClient.prototype, "create").mockResolvedValue("image-session");
    vi.spyOn(AgentsApiClient.prototype, "setReasoningEffort").mockResolvedValue(undefined);
    const upload = vi.spyOn(AgentsApiClient.prototype, "uploadFile").mockResolvedValue(undefined);
    const message = vi.spyOn(AgentsApiClient.prototype, "message").mockResolvedValue(undefined);
    vi.spyOn(AgentsApiClient.prototype, "items").mockResolvedValue([]);
    const image = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAsTAAALEwEAmpwYAAAADUlEQVR4nGP4////KwAJ5gPoxLp9owAAAABJRU5ErkJggg==",
      "base64",
    );
    const originals = ["first", "replacement"].map((label) =>
      Buffer.concat([image, Buffer.from(label)]),
    );
    const harness = registerHarness(state.env);
    try {
      for (const [index, bytes] of originals.entries()) {
        const saved = await saveMediaBuffer(bytes, "image/png", "inbound");
        const media = [{ url: `media://inbound/${saved.id}`, fileName: "scene.png" }];
        const result = await harness.runAttempt({
          ...params,
          runId: `image-turn-${index}`,
          prompt: "Describe this image.",
          images: [{ type: "image", data: image.toString("base64"), mimeType: "image/png" }],
          hostCapabilities: {
            ...params.hostCapabilities,
            resolveInputAttachmentMedia: async () => media,
          },
        });
        expect(result).toMatchObject({ terminal: { kind: "ok" } });
      }
      const firstFile = create.mock.calls[0]?.[3]?.files?.[0];
      const nextFile = upload.mock.calls[0]?.[1];
      expect(firstFile).toBeDefined();
      expect(nextFile).toBeDefined();
      expect(Buffer.from(firstFile!.data, "base64")).toEqual(originals[0]);
      expect(Buffer.from(nextFile!.data, "base64")).toEqual(originals[1]);
      expect(new Set([firstFile!.path, nextFile!.path]).size).toBe(2);
      for (const [index, file] of [firstFile!, nextFile!].entries()) {
        expect(path.posix.dirname(file.path)).toBe("/workspace/inputs");
        expect(path.posix.basename(file.path)).toMatch(/-scene\.png$/u);
        expect(message.mock.calls[index]?.[1]).toContain(file.path);
      }
      expect(create).toHaveBeenCalledTimes(1);
      expect(upload).toHaveBeenCalledExactlyOnceWith(
        "image-session",
        nextFile,
        expect.any(AbortSignal),
      );
      expect(message.mock.calls.map(([sessionId]) => sessionId)).toEqual([
        "image-session",
        "image-session",
      ]);
      expect(upload.mock.invocationCallOrder[0]).toBeLessThan(message.mock.invocationCallOrder[1]!);
    } finally {
      await harness.dispose();
    }
  });
});

it("reports unsupported tool restrictions without replacing the bound native session", async () => {
  await withOpenClawTestState({ label: "agentsapi-tool-policy-preflight" }, async (state) => {
    const params = await createAttempt(state.stateDir);
    const create = vi
      .spyOn(AgentsApiClient.prototype, "create")
      .mockResolvedValue("retained-session");
    vi.spyOn(AgentsApiClient.prototype, "setReasoningEffort").mockResolvedValue(undefined);
    const message = vi.spyOn(AgentsApiClient.prototype, "message").mockResolvedValue(undefined);
    vi.spyOn(AgentsApiClient.prototype, "items").mockResolvedValue([]);
    const harness = registerHarness(state.env);
    try {
      expect(await harness.runAttempt(params)).toMatchObject({ terminal: { kind: "ok" } });
      const restricted = harness.runAttempt({
        ...params,
        runId: "restricted-run",
        pluginHarnessToolPolicyRestricted: true,
      });
      await expect(restricted).rejects.toBeInstanceOf(AgentHarnessPreflightError);
      await expect(restricted).rejects.toMatchObject({
        scope: "harness",
        userMessage:
          "Agents API cannot run with this chat's tool restrictions because it cannot enforce them on native tools. Choose a harness that supports these restrictions or update the tool settings.",
      });
      expect(create).toHaveBeenCalledTimes(1);
      expect(message).toHaveBeenCalledTimes(1);

      expect(await harness.runAttempt({ ...params, runId: "allowed-following-run" })).toMatchObject(
        {
          terminal: { kind: "ok" },
        },
      );
      expect(create).toHaveBeenCalledTimes(1);
      expect(message.mock.calls.map(([sessionId]) => sessionId)).toEqual([
        "retained-session",
        "retained-session",
      ]);
    } finally {
      await harness.dispose();
    }
  });
});

it.each([false, true])(
  "reports Gateway sandbox placement independently of images (%s)",
  async (withImages) => {
    await withOpenClawTestState({ label: "agentsapi-sandbox-preflight" }, async (state) => {
      const params = await createAttempt(state.stateDir);
      const harness = registerHarness(state.env);
      try {
        const pending = harness.runAttempt({
          ...params,
          sandbox: createSandboxTestContext(),
          images: withImages
            ? [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }]
            : undefined,
        });
        await expect(pending).rejects.toBeInstanceOf(AgentHarnessPreflightError);
        await expect(pending).rejects.toMatchObject({
          scope: "harness",
          message: "Agents API does not support Gateway sandbox placement.",
          userMessage:
            "Agents API cannot run in the configured Gateway sandbox. Choose a harness that supports Gateway sandbox placement before retrying.",
        });
      } finally {
        await harness.dispose();
      }
    });
  },
);

function registerHarness(env: NodeJS.ProcessEnv, readConfig: () => OpenClawConfig = () => ({})) {
  const runtime = createPluginRuntimeMock({ config: { current: readConfig } });
  runtime.state.openKeyedStore = <T>(options: Parameters<typeof runtime.state.openKeyedStore>[0]) =>
    createPluginStateKeyedStoreForTests<T>("agentsapi", { ...options, env });
  runtime.state.openSyncKeyedStore = <T>(
    options: Parameters<typeof runtime.state.openSyncKeyedStore>[0],
  ) => createPluginStateSyncKeyedStoreForTests<T>("agentsapi", { ...options, env });
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
