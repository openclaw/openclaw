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
import { AgentsApiClient, type AgentsApiInputFile } from "./agentsapi-client.js";
import plugin from "./index.js";

const { createSession, fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  createSession: vi.fn<typeof import("./agentsapi-session.js").createAgentsApiSession>(),
  fetchWithSsrFGuardMock:
    vi.fn<typeof import("openclaw/plugin-sdk/ssrf-runtime").fetchWithSsrFGuard>(),
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
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

beforeEach(() => {
  fetchWithSsrFGuardMock.mockReset().mockImplementation(() => {
    throw new Error("Unexpected live request in the Agents API persistence fixture");
  });
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

it.each(["inline images", "oversized original"])(
  "continues %s and the following turn on the same native session",
  async (inputKind) => {
    await withOpenClawTestState({ label: "agentsapi-image-recovery" }, async (state) => {
      const params = await createAttempt(state.stateDir);
      const create = vi
        .spyOn(AgentsApiClient.prototype, "create")
        .mockResolvedValue("image-session");
      vi.spyOn(AgentsApiClient.prototype, "setReasoningEffort").mockResolvedValue(undefined);
      const message = vi.spyOn(AgentsApiClient.prototype, "message").mockResolvedValue(undefined);
      vi.spyOn(AgentsApiClient.prototype, "items").mockResolvedValue([]);
      const original =
        inputKind === "oversized original"
          ? await saveMediaBuffer(
              Buffer.alloc(5 * 1024 * 1024 + 1, 32),
              "application/pdf",
              "inbound",
              5 * 1024 * 1024 + 1,
              "brief.pdf",
            )
          : undefined;
      const prompt = original
        ? "Summarize the supplied extracted text: the launch window is October."
        : "Read the supplied image.";
      const harness = registerHarness(state.env);
      try {
        const result = await harness.runAttempt({
          ...params,
          prompt,
          media: original ? [{ path: original.path, sizeBytes: 1 }] : undefined,
          images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
        });
        expect(result).toMatchObject({ terminal: { kind: "ok" } });
        const input = message.mock.calls[0]![1];
        expect(input).toContain(prompt);
        expect(input).toContain("The Agents API harness does not support inline image inputs.");
        expect(input).toContain(
          "No confirmed execution paths are available for this message's original attachments.",
        );
        expect(input).toContain("ask for a text description if the image is necessary");
        if (original) {
          expect(input).toContain(
            "Input attachment feedback: 1 attachment(s) were not transferred to the hosted VM.",
          );
          expect(input).toContain("exceeds the 5 MiB file limit");
          expect(input).toContain("ask for a smaller attachment or the relevant text");
          expect(create.mock.calls[0]?.[3]?.files).toEqual([]);
        }
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
  },
);

it.each([
  { availability: "connected", uploadsBeforeDisconnect: 2 },
  { availability: "disconnected", uploadsBeforeDisconnect: 0 },
  { availability: "disconnected after a partial upload", uploadsBeforeDisconnect: 1 },
])(
  "continues with original attachments on the same $availability hosted session",
  async ({ uploadsBeforeDisconnect }) => {
    await withOpenClawTestState({ label: "agentsapi-original-images" }, async (state) => {
      const params = await createAttempt(state.stateDir);
      const create = vi
        .spyOn(AgentsApiClient.prototype, "create")
        .mockResolvedValue("image-session");
      vi.spyOn(AgentsApiClient.prototype, "setReasoningEffort").mockResolvedValue(undefined);
      const upload = vi.spyOn(AgentsApiClient.prototype, "uploadFile");
      const message = vi.spyOn(AgentsApiClient.prototype, "message").mockResolvedValue(undefined);
      vi.spyOn(AgentsApiClient.prototype, "items").mockResolvedValue([]);
      let uploadedCount = 0;
      fetchWithSsrFGuardMock.mockImplementation(async ({ url, init, beforeRequest }) => {
        beforeRequest?.();
        const request = new Request(url, init);
        const pathname = new URL(url).pathname;
        let response: Response;
        if (pathname === "/v1/agents/sessions/image-session") {
          response = Response.json({
            id: "image-session",
            environment: { type: "openai_hosted", id: "image-environment" },
          });
        } else if (pathname === "/v1/agents/environments/image-environment") {
          response = Response.json({
            id: "image-environment",
            type: "openai_hosted",
            status: uploadedCount < uploadsBeforeDisconnect ? "connected" : "disconnected",
          });
        } else if (
          pathname === "/v1/agents/environments/image-environment/files" &&
          request.method === "POST"
        ) {
          const file: AgentsApiInputFile = await request.json();
          uploadedCount++;
          response = Response.json({
            environment_id: "image-environment",
            path: file.path,
            size_bytes: Buffer.from(file.data, "base64").length,
          });
        } else {
          throw new Error(`Unexpected fixture request: ${request.method} ${pathname}`);
        }
        return { response, finalUrl: url, release: async () => {} };
      });
      const image = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAsTAAALEwEAmpwYAAAADUlEQVR4nGP4////KwAJ5gPoxLp9owAAAABJRU5ErkJggg==",
        "base64",
      );
      const originals = ["first", "replacement", "companion"].map((label) =>
        Buffer.concat([image, Buffer.from(label)]),
      );
      const harness = registerHarness(state.env);
      try {
        for (const [index, batch] of [[originals[0]!], originals.slice(1)].entries()) {
          const media = await Promise.all(
            batch.map(async (bytes) => {
              const saved = await saveMediaBuffer(bytes, "image/png", "inbound");
              return { url: `media://inbound/${saved.id}`, fileName: "scene.png" };
            }),
          );
          const result = await harness.runAttempt({
            ...params,
            runId: `image-turn-${index}`,
            prompt: "Describe the current attachments, including the replacement image.",
            images: [{ type: "image", data: image.toString("base64"), mimeType: "image/png" }],
            hostCapabilities: {
              ...params.hostCapabilities,
              resolveInputAttachmentMedia: async () => media,
            },
          });
          expect(result).toMatchObject({ terminal: { kind: "ok" } });
        }
        const firstFile = create.mock.calls[0]?.[3]?.files?.[0];
        expect(firstFile).toBeDefined();
        expect(Buffer.from(firstFile!.data, "base64")).toEqual(originals[0]);
        expect(message.mock.calls[0]?.[1]).toContain(firstFile!.path);
        const attemptedFiles = upload.mock.calls.map(([, file]) => file);
        expect(attemptedFiles).toHaveLength(Math.min(uploadsBeforeDisconnect + 1, 2));
        expect(uploadedCount).toBe(uploadsBeforeDisconnect);
        expect(new Set([firstFile!, ...attemptedFiles].map((file) => file.path)).size).toBe(
          1 + attemptedFiles.length,
        );
        for (const [index, file] of attemptedFiles.entries()) {
          expect(path.posix.dirname(file.path)).toBe("/workspace/inputs");
          expect(path.posix.basename(file.path)).toMatch(/-scene\.png$/u);
          expect(Buffer.from(file.data, "base64")).toEqual(originals[index + 1]);
        }
        const input = message.mock.calls[1]![1];
        expect(input).toContain(
          "Describe the current attachments, including the replacement image.",
        );
        if (uploadsBeforeDisconnect === 2) {
          for (const file of attemptedFiles) {
            expect(input).toContain(file.path);
          }
        } else {
          expect(input).toContain("The hosted environment is unavailable for file uploads.");
          expect(input).toContain(
            "There are no confirmed hosted VM paths for this message's attachments",
          );
          expect(input).toContain(
            "Files retained from earlier turns do not establish the contents of these new attachments.",
          );
          expect(input).toContain("available Gateway tools that can access the originals");
          expect(input).toContain(
            "No confirmed execution paths are available for this message's original attachments.",
          );
          for (const file of attemptedFiles) {
            expect(input).not.toContain(file.path);
          }
        }
        expect(create).toHaveBeenCalledTimes(1);
        expect(message.mock.calls.map(([sessionId]) => sessionId)).toEqual([
          "image-session",
          "image-session",
        ]);
        for (const invocation of upload.mock.invocationCallOrder) {
          expect(invocation).toBeLessThan(message.mock.invocationCallOrder[1]!);
        }
      } finally {
        await harness.dispose();
      }
    });
  },
);

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
