import "./btw.mocks.test-support.js";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it, vi } from "vitest";
import { consumeReplyUsageState } from "../auto-reply/reply/reply-usage-state.js";
import type { SessionEntry } from "../config/sessions.js";
import { onInternalDiagnosticEvent } from "../infra/diagnostic-events.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { PluginRegistryInspectionResources } from "../plugins/registry-inspection-resources.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { getPluginRuntimeGenerationRegistry } from "../plugins/runtime/generation-scope.js";
import {
  looksLikeSecretSentinel,
  mintSecretSentinel,
  resolveSecretSentinel,
} from "../secrets/sentinel.js";
import { AsyncWorkScope, trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createApiKeyCredential } from "./auth-profiles/credential-fixtures.test-support.js";
import {
  state,
  runBtwSideQuestion,
  registerAgentHarness,
  DEFAULT_AGENT_DIR,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  DEFAULT_SESSION_KEY,
  DEFAULT_STORE_PATH,
  DEFAULT_QUESTION,
  MATH_QUESTION,
  MATH_ANSWER,
  makeAsyncEvents,
  createSessionEntry,
  createAssistantDoneEvent,
  createDoneEvent,
  createThinkingOnlyDoneEvent,
  mockDoneAnswer,
  mockCliOutput,
  registerCodexSideQuestionHarness,
  supportsPreparedOpenAIAuth,
  createSideQuestionParams,
  runSideQuestion,
  runMathSideQuestion,
  clearBuiltSessionMessages,
  createUserTranscriptMessage,
  createAssistantTranscriptMessage,
  createTranscriptEntry,
  mockTranscriptEntries,
  mockActiveTranscript,
  mockCall,
  mockArg,
  runMathSideQuestionAndCaptureContext,
  expectRecordFields,
  streamContext,
  contextMessages,
  expectTextBlockContains,
  firstTextBlockIncludes,
  expectNoAssistantMessages,
  expectSanitizedAssistantContext,
  expectSeedOnlyUserContext,
  mockOpenAIPlatformProfile,
  streamSimpleMock,
  readFileMock,
  buildSessionContextMock,
  ensureOpenClawModelsJsonMock,
  loadPreparedModelRuntimeSnapshotMock,
  snapshotResources,
  discoverAuthStorageMock,
  discoverModelsMock,
  resolveModelWithRegistryMock,
  ensureAuthProfileStoreMock,
  ensureAuthProfileStoreWithoutExternalProfilesMock,
  resolveModelAsyncMock,
  getApiKeyForModelMock,
  requireApiKeyMock,
  resolveSessionAuthSelectionMock,
  getActiveEmbeddedRunSnapshotMock,
  resolveSessionAgentIdMock,
  resolveAgentWorkspaceDirMock,
  prepareProviderRuntimeAuthMock,
  registerProviderStreamForModelMock,
  resolveEmbeddedAgentStreamMock,
  prepareCliRunContextMock,
  executePreparedCliRunMock,
  diagDebugMock,
  ensureSelectedAgentHarnessPluginMock,
  createAgentHarnessHostCapabilitiesMock,
  closeAgentHarnessHostCapabilitiesMock,
  agentHarnessHostCapabilitiesMock,
  listSessionEntriesCoreMock,
  loadSessionEntryMock,
  loadTranscriptEventsMock,
  resolveProviderEntryApiKeyProfileReferenceMock,
  preparedRuntimeSnapshotState,
  setupBtwTestHooks,
} from "./btw.test-support.js";
import {
  createModelGenerationFixture,
  publishCurrentModelGeneration,
} from "./embedded-agent-runner/model.generation-scope.test-support.js";
import type { AgentHarness } from "./harness/types.js";
import type { AgentRuntimeAuthPlan } from "./runtime-plan/types.js";

function createCliRuntimeConfig(): Parameters<typeof runBtwSideQuestion>[0]["cfg"] {
  return {
    agents: {
      defaults: {
        models: { "anthropic/claude-opus-4-7": { agentRuntime: { id: "claude-cli" } } },
      },
    },
  };
}

function createSeedTranscript() {
  const userEntry = createTranscriptEntry({
    id: "user-seed",
    message: createUserTranscriptMessage(),
  });
  const assistantEntry = createTranscriptEntry({
    id: "assistant-seed",
    parentId: "user-seed",
    message: createAssistantTranscriptMessage([{ type: "text", text: "seed answer" }]),
  });
  return { userEntry, assistantEntry };
}

function createOpenAIModel(subscription = false) {
  return {
    provider: "openai",
    id: "gpt-5.5",
    api: subscription ? ("openai-chatgpt-responses" as const) : ("openai-responses" as const),
    baseUrl: subscription ? "https://chatgpt.com/backend-api/codex" : "https://api.openai.com/v1",
  };
}

describe("runBtwSideQuestion", () => {
  setupBtwTestHooks();

  it("returns only final text when block streaming is unavailable", async () => {
    const onReasoningStream = vi.fn();
    const onReasoningEnd = vi.fn();
    streamSimpleMock.mockReturnValue(
      makeAsyncEvents([
        createAssistantDoneEvent([
          { type: "thinking", thinking: "Hidden reasoning." },
          { type: "text", text: "Final answer." },
        ]),
      ]),
    );

    const result = await runSideQuestion({ opts: { onReasoningStream, onReasoningEnd } });

    expect(result).toEqual({ text: "Final answer." });
    expect(onReasoningStream).not.toHaveBeenCalled();
    expect(onReasoningEnd).not.toHaveBeenCalled();
    const ensureArgs = mockCall(ensureOpenClawModelsJsonMock);
    expect(ensureArgs?.[1]).toBe(DEFAULT_AGENT_DIR);
    expect(ensureArgs?.[2]).toEqual({ workspaceDir: "/tmp/workspace" });
    expect(discoverModelsMock).toHaveBeenCalledWith(undefined, DEFAULT_AGENT_DIR, {
      config: ensureArgs?.[0],
      workspaceDir: "/tmp/workspace",
    });
  });

  it.each(["off", "on", "stream"] as const)(
    "keeps admitted %s reasoning visibility when caller input changes",
    async (mode) => {
      const onReasoningStream = vi.fn();
      const onReasoningEnd = vi.fn();
      const input = createSideQuestionParams({
        resolvedReasoningLevel: mode,
        opts: {
          onAssistantMessageStart: async () => {
            input.resolvedReasoningLevel = mode === "off" ? "on" : "off";
          },
          onReasoningStream,
          onReasoningEnd,
        },
      });
      const done = createDoneEvent("Final answer.");
      streamSimpleMock.mockReturnValue(
        makeAsyncEvents([
          { type: "start", partial: done.message },
          { type: "thinking_delta", delta: "One " },
          { type: "thinking_delta", delta: "two" },
          { type: "thinking_end" },
          done,
        ]),
      );

      await expect(runBtwSideQuestion(input)).resolves.toEqual({ text: "Final answer." });
      expect(onReasoningStream.mock.calls).toEqual(
        mode === "off"
          ? []
          : [[{ text: "One ", isReasoning: true }], [{ text: "One two", isReasoning: true }]],
      );
      expect(onReasoningEnd).toHaveBeenCalledTimes(mode === "off" ? 0 : 1);
    },
  );

  it.each([
    { harness: "openclaw", sandboxSessionKey: undefined },
    { harness: "codex", sandboxSessionKey: undefined },
    { harness: "codex", sandboxSessionKey: "agent:main:policy" },
  ])(
    "retains the selected global agent for $harness with policy $sandboxSessionKey",
    async ({ harness, sandboxSessionKey }) => {
      // Gateway startup publishes configured owners with allowGatewaySubagentBinding
      // (server-startup-post-attach.ts), and that flag is part of the owner key
      // (prepared-model-runtime.owner.ts). A gateway-hosted BTW request that omits
      // it matches no owner, and standalone activation is refused while the gateway
      // lifecycle is active, so the side question fails with "owner was not published".
      mockDoneAnswer("Final answer.");
      resolveSessionAgentIdMock.mockImplementation(
        (await vi.importActual<typeof import("./agent-scope.js")>("./agent-scope.js"))
          .resolveSessionAgentId,
      );
      const sideQuestion = harness === "codex" ? registerCodexSideQuestionHarness() : undefined;

      await runSideQuestion({
        agentId: "work",
        cfg: {
          agents: { ownership: "explicit", entries: { main: {}, work: {} } },
          session: { scope: "global" },
        },
        sessionKey: "global",
        sandboxSessionKey,
        allowGatewaySubagentBinding: true,
      });

      expect(mockCall(loadPreparedModelRuntimeSnapshotMock)?.[0]).toMatchObject({
        agentDir: DEFAULT_AGENT_DIR,
        agentId: "work",
        allowGatewaySubagentBinding: true,
      });
      expect(resolveSessionAuthSelectionMock).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "work" }),
      );
      if (sideQuestion) {
        expect(sideQuestion).toHaveBeenCalledWith(
          expect.objectContaining({ agentId: "work", sessionKey: "global" }),
        );
      }
    },
  );

  it("keeps gateway subagent binding off for local callers such as the embedded TUI", async () => {
    // The embedded TUI calls runBtwSideQuestion directly and must not borrow the
    // active registry's subagent and node capabilities, so the flag stays unset
    // unless a gateway-hosted caller opts in.
    mockDoneAnswer("Final answer.");

    await runSideQuestion();

    expect(mockCall(loadPreparedModelRuntimeSnapshotMock)?.[0]).not.toHaveProperty(
      "allowGatewaySubagentBinding",
    );
  });

  it.each(["harness cleanup", "harness error", "stream output and transport"] as const)(
    "keeps the source database through %s after its publication retires",
    async (mode) => {
      const file = state.path(`btw-${mode.replaceAll(" ", "-")}.sqlite`);
      const database = new DatabaseSync(file);
      database.exec("CREATE TABLE answer (value INTEGER); INSERT INTO answer VALUES (42)");
      const source = new PluginRegistryInspectionResources(async () => {});
      source.attach(createEmptyPluginRegistry());
      let disposals = 0;
      source.runRegistration("btw-fixture", () =>
        source.register("btw-fixture", {
          id: "database",
          dispose: () => {
            disposals++;
            database.close();
          },
        }),
      );
      snapshotResources.acquire = () => source.retain();
      const entered = createDeferredCore();
      const finish = createDeferredCore();
      const tailEntered = createDeferredCore();
      const finishTail = createDeferredCore();
      const owner = new AsyncWorkScope();
      let operation: Promise<unknown> | undefined;
      let tailValue: unknown;
      try {
        if (mode !== "stream output and transport") {
          const runHarness = registerCodexSideQuestionHarness();
          runHarness.mockImplementationOnce(async () => {
            try {
              entered.resolve();
              await finish.promise;
              if (mode === "harness error") {
                throw new Error("side question failed");
              }
              return { text: String(database.prepare("SELECT value FROM answer").get()?.value) };
            } finally {
              tailEntered.resolve();
              await finishTail.promise;
              tailValue = database.prepare("SELECT value FROM answer").get()?.value;
            }
          });
          operation = owner.track(() => runSideQuestion());
        } else {
          streamSimpleMock.mockImplementationOnce(() => {
            void trackAsyncWork(async () => {
              tailEntered.resolve();
              await finishTail.promise;
              tailValue = database.prepare("SELECT value FROM answer").get()?.value;
            });
            return makeAsyncEvents([{ type: "text_start" }, createDoneEvent("The answer is 42.")]);
          });
          operation = owner.track(() =>
            runSideQuestion({
              opts: {
                onAssistantMessageStart: async () => {
                  entered.resolve();
                  await finish.promise;
                  expect(database.prepare("SELECT value FROM answer").get()?.value).toBe(42);
                },
              },
            }),
          );
        }
        const outcome = operation.catch((error: unknown) => error);
        await Promise.race([
          entered.promise,
          operation.then(() => {
            throw new Error("Side question completed before its controlled operation");
          }),
        ]);
        await source.release();
        expect(database.isOpen).toBe(true);
        expect(disposals).toBe(0);
        finish.resolve();
        await tailEntered.promise;
        if (mode === "stream output and transport") {
          expect(await outcome).toEqual({ text: "The answer is 42." });
        }
        expect(database.isOpen).toBe(true);
        finishTail.resolve();
        if (mode === "harness cleanup") {
          expect(await outcome).toEqual({ text: "42" });
        } else if (mode === "harness error") {
          expect(await outcome).toEqual(new Error("side question failed"));
        }
        await owner.drain();
        expect(tailValue).toBe(42);
        await expect.poll(() => disposals).toBe(1);
        expect(database.isOpen).toBe(false);
        const reopened = new DatabaseSync(file, { readOnly: true });
        try {
          expect(reopened.prepare("SELECT value FROM answer").get()?.value).toBe(42);
        } finally {
          reopened.close();
        }
      } finally {
        finish.resolve();
        finishTail.resolve();
        await Promise.allSettled([operation, owner.drain(), source.release()]);
        if (database.isOpen) {
          database.close();
        }
      }
    },
  );

  it("keeps model, runtime auth, and stream selection on prepared A after current advances to B", async () => {
    const cfg = { agents: { entries: { main: { default: true } } } } as never;
    const generationA = createModelGenerationFixture({
      agentDir: state.agentDir(),
      workspaceDir: state.workspaceDir,
      config: cfg,
      label: "btw-a",
      provider: "local-proxy",
      requestProvider: "local-proxy",
      modelId: "side-model",
    });
    const generationB = createModelGenerationFixture({
      agentDir: state.agentDir(),
      workspaceDir: state.workspaceDir,
      config: cfg,
      label: "btw-b",
      provider: "local-proxy",
      requestProvider: "local-proxy",
      modelId: "side-model",
    });
    preparedRuntimeSnapshotState.snapshot = generationA.preparedModelRuntime;
    preparedRuntimeSnapshotState.useSnapshotPluginRegistry = true;
    resolveAgentWorkspaceDirMock.mockReturnValue(state.workspaceDir);
    publishCurrentModelGeneration(generationB);
    const runtimeAuthA = vi.fn(async () => ({ apiKey: "runtime-auth-a" }));
    const runtimeAuthB = vi.fn(async () => ({ apiKey: "runtime-auth-b" }));
    const streamA = vi.fn(
      (model: { name?: string }, _context: unknown, options?: { apiKey?: string }) => {
        const apiKey = options?.apiKey;
        const resolvedApiKey =
          apiKey && looksLikeSecretSentinel(apiKey) ? resolveSecretSentinel(apiKey) : apiKey;
        return makeAsyncEvents([
          createDoneEvent(`${model.name ?? "missing model"} / ${resolvedApiKey} / Stream A`),
        ]);
      },
    );
    const streamB = vi.fn(() =>
      makeAsyncEvents([createDoneEvent("Generation B / runtime-auth-b / Stream B")]),
    );
    const activeGenerationRegistry = () =>
      getPluginRuntimeGenerationRegistry() ?? getActivePluginRegistry();
    resolveModelWithRegistryMock.mockImplementation(() => {
      const snapshot = getCurrentPluginMetadataSnapshot({
        config: cfg,
        workspaceDir: state.workspaceDir,
      });
      const label = snapshot === generationA.metadataSnapshot ? "A" : "B";
      return {
        provider: "local-proxy",
        id: "side-model",
        name: `Generation ${label}`,
        api: "openai-responses",
        baseUrl: `https://generation-${label.toLowerCase()}.example.test/v1`,
      };
    });
    prepareProviderRuntimeAuthMock.mockImplementation(async () =>
      activeGenerationRegistry() === generationA.pluginRegistry
        ? await runtimeAuthA()
        : await runtimeAuthB(),
    );
    registerProviderStreamForModelMock.mockImplementation(() =>
      activeGenerationRegistry() === generationA.pluginRegistry ? streamA : streamB,
    );

    await expect(
      runSideQuestion({ cfg, provider: "local-proxy", model: "side-model" }),
    ).resolves.toEqual({ text: "Generation A / runtime-auth-a / Stream A" });
    expect(runtimeAuthA).toHaveBeenCalledOnce();
    expect(runtimeAuthB).not.toHaveBeenCalled();
    expect(streamA).toHaveBeenCalledOnce();
    expect(streamA).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Generation A" }),
      expect.any(Object),
      expect.any(Object),
    );
    expect(streamB).not.toHaveBeenCalled();
    expect(streamSimpleMock).not.toHaveBeenCalled();
  });

  it("routes Codex-selected BTW questions through the harness side-question hook", async () => {
    const supports = vi.fn(supportsPreparedOpenAIAuth);
    const codexSideQuestionMock = registerCodexSideQuestionHarness({
      supports,
    });
    resolveModelWithRegistryMock.mockReturnValue({
      provider: "openai",
      id: "gpt-5.5",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });
    resolveSessionAuthSelectionMock.mockResolvedValue({
      profileId: "openai:work",
      source: "auto",
      routeRequirement: "subscription",
    });
    ensureAuthProfileStoreMock.mockReturnValue({
      version: 1,
      profiles: {
        "openai:work": {
          type: "token",
          provider: "openai",
          token: "subscription-token",
          expires: Date.now() + 60_000,
        },
      },
      order: { openai: ["openai:work"] },
    });
    resolveModelAsyncMock.mockImplementation(
      async (
        _provider: string,
        _modelId: string,
        _agentDir: string,
        _config: unknown,
        options?: { authProfileMode?: string },
      ) => ({
        model:
          options?.authProfileMode === "token"
            ? {
                provider: "openai",
                id: "gpt-5.5",
                api: "openai-chatgpt-responses",
                baseUrl: "https://chatgpt.com/backend-api/codex",
              }
            : resolveModelWithRegistryMock(),
      }),
    );
    getApiKeyForModelMock.mockResolvedValue({
      apiKey: "subscription-token",
      mode: "token",
      source: "profile:openai:work",
      profileId: "openai:work",
    });

    const result = await runSideQuestion({
      provider: "openai",
      model: "gpt-5.5",
      sessionKey: DEFAULT_SESSION_KEY,
      authorityRunId: "btw-side-authority",
      opts: { runId: "parent-correlation" },
      sandboxSessionKey: "agent:main:runtime-policy",
      agentAccountId: "account-1",
      groupId: "group-1",
      groupChannel: "#ops",
      groupSpace: "workspace-1",
      spawnedBy: "agent:main:parent",
      senderId: "sender-1",
      senderName: "Rosita",
      senderUsername: "rosita",
      senderE164: "+15550001",
    });

    expect(result).toEqual({ text: "Codex side answer." });
    expect(codexSideQuestionMock).toHaveBeenCalledTimes(1);
    expect(codexSideQuestionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-5.5",
        question: DEFAULT_QUESTION,
        sessionId: "session-1",
        agentId: "main",
        workspaceDir: "/tmp/workspace",
        authProfileId: "openai:work",
        agentAccountId: "account-1",
        sandboxSessionKey: "agent:main:runtime-policy",
        groupId: "group-1",
        groupChannel: "#ops",
        groupSpace: "workspace-1",
        spawnedBy: "agent:main:parent",
        senderId: "sender-1",
        senderName: "Rosita",
        senderUsername: "rosita",
        senderE164: "+15550001",
        opts: { runId: "btw-side-authority" },
        runtimeModel: expect.objectContaining({
          api: "openai-chatgpt-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
        }),
      }),
    );
    expect(mockArg(codexSideQuestionMock, 0, 0)).toHaveProperty(
      "hostCapabilities",
      agentHarnessHostCapabilitiesMock,
    );
    expect(createAgentHarnessHostCapabilitiesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: expect.objectContaining({
          admittedRunContext: expect.objectContaining({
            operationalRunInstance: expect.objectContaining({ runId: "btw-side-authority" }),
          }),
          runId: "btw-side-authority",
        }),
      }),
    );
    expect(closeAgentHarnessHostCapabilitiesMock).toHaveBeenCalledOnce();
    expect(resolveModelAsyncMock).toHaveBeenCalledWith(
      "openai",
      "gpt-5.5",
      DEFAULT_AGENT_DIR,
      expect.any(Object),
      expect.objectContaining({
        authProfileMode: "token",
        preparedModelRuntime: expect.objectContaining({
          configuredRuntimeModels: [],
          inlineProviderModels: [],
        }),
      }),
    );
    const preparedModelRuntime = (
      mockArg(resolveModelAsyncMock, 0, 4) as { preparedModelRuntime?: unknown }
    ).preparedModelRuntime;
    expect(mockArg(codexSideQuestionMock, 0, 0)).toHaveProperty(
      "preparedModelRuntime",
      preparedModelRuntime,
    );
    expect(
      (mockArg(codexSideQuestionMock, 0, 0) as { sessionFile?: string }).sessionFile,
    ).toContain("session-1.jsonl");
    expect(streamSimpleMock).not.toHaveBeenCalled();
    expect(registerProviderStreamForModelMock).not.toHaveBeenCalled();
    expect(supports).toHaveBeenCalledWith(
      expect.objectContaining({
        modelProvider: expect.objectContaining({
          preparedAuth: {
            source: "profile",
            mode: "token",
            requirement: "subscription",
          },
        }),
      }),
    );
  });

  it.each([
    { mode: "harness", enabled: false },
    { mode: "direct", enabled: true },
    { mode: "direct-block", enabled: undefined },
  ])(
    "exposes $mode side-question usage with diagnostics enabled: $enabled",
    async ({ mode, enabled }) => {
      const tokens = { input: 13, output: 9, cacheRead: 7, cacheWrite: 3 };
      const usage = { ...tokens, total: 41 };
      const cost = { input: 0.1, output: 0.1, cacheRead: 0.03, cacheWrite: 0.02, total: 0.25 };
      const text = "Side answer.";
      const onBlockReply = vi.fn().mockResolvedValue(undefined);
      if (mode === "harness") {
        registerCodexSideQuestionHarness().mockResolvedValue({ text, usage: { ...usage, cost } });
      } else {
        const done = createDoneEvent(text);
        done.message.usage = { ...tokens, totalTokens: 41, cost };
        streamSimpleMock.mockReturnValue(
          makeAsyncEvents([
            ...(mode === "direct-block"
              ? [
                  { type: "text_delta", delta: text },
                  { type: "text_end", content: text, contentIndex: 0 },
                ]
              : []),
            done,
          ]),
        );
      }
      const runId = `btw-usage-reply-${mode}-${enabled}`;
      const authorityRunId = `btw-usage-authority-${mode}-${enabled}`;
      const sessionEntry = createSessionEntry({ inputTokens: 200, cacheRead: 100 });
      const originalEntry = structuredClone(sessionEntry);
      const diagnostics: unknown[] = [];
      const unsubscribe = onInternalDiagnosticEvent((event) => {
        if (event.type === "model.usage") {
          diagnostics.push(event);
        }
      });
      try {
        await expect(
          runSideQuestion({
            cfg: { diagnostics: { enabled } },
            sessionEntry,
            authorityRunId,
            ...(mode === "direct-block"
              ? {
                  blockReplyChunking: {
                    minChars: 1,
                    maxChars: 200,
                    breakPreference: "paragraph" as const,
                  },
                  resolvedBlockStreamingBreak: "text_end" as const,
                }
              : {}),
            opts: { runId, onBlockReply },
          }),
        ).resolves.toEqual(mode === "direct-block" ? undefined : { text });
        if (mode === "direct-block") {
          expect(onBlockReply).toHaveBeenCalledExactlyOnceWith({
            text,
            btw: { question: DEFAULT_QUESTION },
          });
        }
        expect.soft(consumeReplyUsageState(runId)).toMatchObject({
          usage,
          sessionId: "session-1",
          turnUsd: 0.25,
        });
        expect(consumeReplyUsageState(authorityRunId)).toBeUndefined();
        expect(sessionEntry).toEqual(originalEntry);
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect.soft(diagnostics).toEqual(
          enabled !== false
            ? [
                expect.objectContaining({
                  type: "model.usage",
                  sessionId: "session-1",
                  usage: { ...usage, promptTokens: 23 },
                  costUsd: 0.25,
                }),
              ]
            : [],
        );
      } finally {
        unsubscribe();
      }
    },
  );

  it("keeps an unprofiled subscription token on the OpenClaw BTW path", async () => {
    const supports = vi.fn(supportsPreparedOpenAIAuth);
    const codexSideQuestionMock = registerCodexSideQuestionHarness({ supports });
    const subscriptionModel = createOpenAIModel(true);
    resolveModelWithRegistryMock.mockReturnValue(subscriptionModel);
    resolveModelAsyncMock.mockResolvedValue({ model: subscriptionModel });
    resolveSessionAuthSelectionMock.mockResolvedValue(undefined);
    ensureAuthProfileStoreMock.mockReturnValue({ version: 1, profiles: {} });
    resolveProviderEntryApiKeyProfileReferenceMock.mockReturnValue({ kind: "literal" });
    getApiKeyForModelMock.mockResolvedValue({
      apiKey: "subscription-token",
      mode: "token",
      source: "models.json",
    });
    requireApiKeyMock.mockReturnValue("subscription-token");
    mockDoneAnswer("OpenClaw side answer.");

    await expect(
      runSideQuestion({
        cfg: {
          models: {
            providers: {
              openai: { auth: "token", apiKey: "subscription-token" },
            },
          },
        } as never,
        provider: "openai",
        model: "gpt-5.5",
      }),
    ).resolves.toEqual({ text: "OpenClaw side answer." });

    expect(codexSideQuestionMock).not.toHaveBeenCalled();
    expect(streamSimpleMock).toHaveBeenCalled();
    expect(supports).toHaveBeenCalledWith(
      expect.objectContaining({
        modelProvider: expect.objectContaining({
          preparedAuth: {
            source: "direct",
            mode: "token",
            requirement: "subscription",
          },
        }),
      }),
    );
  });

  it("lets Codex reproduce an unprofiled Platform API key", async () => {
    const supports = vi.fn(supportsPreparedOpenAIAuth);
    const codexSideQuestionMock = registerCodexSideQuestionHarness({ supports });
    const platformModel = createOpenAIModel();
    resolveModelWithRegistryMock.mockReturnValue(platformModel);
    resolveModelAsyncMock.mockResolvedValue({ model: platformModel });
    resolveSessionAuthSelectionMock.mockResolvedValue(undefined);
    ensureAuthProfileStoreMock.mockReturnValue({ version: 1, profiles: {} });
    resolveProviderEntryApiKeyProfileReferenceMock.mockReturnValue({ kind: "literal" });
    getApiKeyForModelMock.mockResolvedValue({
      apiKey: "platform-key",
      mode: "api-key",
      source: "models.json",
    });

    await expect(
      runSideQuestion({
        cfg: {
          models: { providers: { openai: { apiKey: "platform-key" } } },
        } as never,
        provider: "openai",
        model: "gpt-5.5",
      }),
    ).resolves.toEqual({ text: "Codex side answer." });

    expect(codexSideQuestionMock).toHaveBeenCalledOnce();
    expect(
      (
        mockArg(codexSideQuestionMock, 0, 0) as {
          preparedRuntimeAuth?: { resolvedApiKey?: string };
        }
      ).preparedRuntimeAuth?.resolvedApiKey,
    ).toBe("platform-key");
    expect(supports).toHaveBeenCalledWith(
      expect.objectContaining({
        modelProvider: expect.objectContaining({
          preparedAuth: {
            source: "direct",
            mode: "api-key",
            requirement: "api-key",
          },
        }),
      }),
    );
  });

  it("lets native Codex bootstrap auth without a host profile", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const supports = vi.fn((ctx: Parameters<AgentHarness["supports"]>[0]) => {
      if (ctx.modelProvider?.preparedAuth?.source !== "harness") {
        return supportsPreparedOpenAIAuth(ctx);
      }
      return ctx.modelProvider.requestTransportOverrides === "none" &&
        ctx.modelProvider.runtimePolicy?.compatibleIds.includes("codex")
        ? { supported: true as const, priority: 100 }
        : { supported: false as const, reason: "deferred route support is missing" };
    });
    const codexSideQuestionMock = registerCodexSideQuestionHarness({
      authBootstrap: "harness",
      supports,
    });
    const platformModel = createOpenAIModel();
    resolveModelWithRegistryMock.mockReturnValue(platformModel);
    resolveSessionAuthSelectionMock.mockResolvedValue(undefined);
    ensureAuthProfileStoreMock.mockReturnValue({ version: 1, profiles: {} });
    getApiKeyForModelMock.mockResolvedValue({
      apiKey: undefined,
      mode: "api-key",
      source: "none",
    });

    await expect(runSideQuestion({ provider: "openai", model: "gpt-5.5" })).resolves.toEqual({
      text: "Codex side answer.",
    });

    expect(codexSideQuestionMock).toHaveBeenCalledOnce();
    const preparedRuntimeAuth = (
      mockArg(codexSideQuestionMock, 0, 0) as {
        preparedRuntimeAuth?: {
          plan?: AgentRuntimeAuthPlan;
          authProfileStore?: { profiles?: Record<string, unknown> };
          resolvedApiKey?: string;
        };
      }
    ).preparedRuntimeAuth;
    expect(preparedRuntimeAuth?.plan).toMatchObject({
      harnessAuthProvider: "openai",
    });
    expect(preparedRuntimeAuth?.plan?.forwardedAuthProfileId).toBeUndefined();
    expect(preparedRuntimeAuth?.resolvedApiKey).toBeUndefined();
    expect(Object.keys(preparedRuntimeAuth?.authProfileStore?.profiles ?? {})).toEqual([]);
    expect(supports).toHaveBeenCalledWith(
      expect.objectContaining({
        modelProvider: expect.objectContaining({
          preparedAuth: { source: "harness" },
        }),
      }),
    );
  });

  it("hands a Codex side question the resolved Platform backup after subscription failure", async () => {
    const supports = vi.fn(supportsPreparedOpenAIAuth);
    const codexSideQuestionMock = registerCodexSideQuestionHarness({
      supports,
    });
    const subscriptionModel = createOpenAIModel(true);
    const platformModel = createOpenAIModel();
    ensureAuthProfileStoreMock.mockReturnValue({
      version: 1,
      profiles: {
        "openai:subscription": {
          type: "token",
          provider: "openai",
          token: "unresolved-token",
          expires: Date.now() + 60_000,
        },
        "openai:platform": createApiKeyCredential("openai", "platform-key"),
      },
      order: { openai: ["openai:subscription", "openai:platform"] },
    });
    resolveSessionAuthSelectionMock.mockResolvedValue(undefined);
    resolveModelWithRegistryMock.mockReturnValue(platformModel);
    resolveModelAsyncMock.mockImplementation(
      async (
        _provider: string,
        _modelId: string,
        _agentDir: string,
        _config: unknown,
        options?: { authProfileId?: string },
      ) => ({
        model: options?.authProfileId === "openai:subscription" ? subscriptionModel : platformModel,
      }),
    );
    getApiKeyForModelMock.mockImplementation(async (authParams: { profileId?: string }) => {
      if (authParams.profileId === "openai:subscription") {
        throw new Error("subscription credential resolution failed");
      }
      return {
        apiKey: "platform-key",
        mode: "api-key",
        source: "profile:openai:platform",
        profileId: "openai:platform",
      };
    });

    await expect(
      runSideQuestion({
        cfg: {
          auth: {
            order: { openai: ["openai:subscription", "openai:platform"] },
          },
          agents: {
            defaults: {
              models: {
                "openai/gpt-5.5": { agentRuntime: { id: "codex" } },
              },
            },
          },
        } as never,
        provider: "openai",
        model: "gpt-5.5",
        sessionKey: DEFAULT_SESSION_KEY,
      }),
    ).resolves.toEqual({ text: "Codex side answer." });

    const sideQuestionParams = mockArg(codexSideQuestionMock, 0, 0) as {
      authProfileId?: string;
      runtimeModel?: { api?: string; baseUrl?: string };
      preparedRuntimeAuth?: {
        resolvedApiKey?: string;
        plan?: { modelRoute?: { authRequirement?: string } };
        authProfileStore?: { profiles?: Record<string, unknown> };
      };
    };
    expect(sideQuestionParams.runtimeModel).toMatchObject(platformModel);
    expect(sideQuestionParams.authProfileId).toBeUndefined();
    expect(sideQuestionParams.preparedRuntimeAuth).toMatchObject({
      resolvedApiKey: "platform-key",
      plan: { modelRoute: { authRequirement: "api-key" } },
    });
    expect(
      Object.keys(sideQuestionParams.preparedRuntimeAuth?.authProfileStore?.profiles ?? {}),
    ).toEqual([]);
    expect(streamSimpleMock).not.toHaveBeenCalled();
    expect(supports).toHaveBeenCalledWith(
      expect.objectContaining({
        modelProvider: expect.objectContaining({
          preparedAuth: {
            source: "profile",
            mode: "api-key",
            requirement: "api-key",
          },
        }),
      }),
    );
  });

  it("uses registry ownership and closes host capabilities when a BTW hook rejects", async () => {
    registerAgentHarness(
      {
        id: "spoofed",
        label: "Spoofed BTW harness",
        pluginId: "codex",
        supports: () => ({ supported: true, priority: 100 }),
        runAttempt: vi.fn(),
        runSideQuestion: vi.fn().mockRejectedValue(new Error("side question failed")),
      },
      { ownerPluginId: "actual-owner" },
    );

    await expect(runSideQuestion()).rejects.toThrow("side question failed");

    expect(createAgentHarnessHostCapabilitiesMock).toHaveBeenCalledWith(
      expect.objectContaining({ pluginId: "actual-owner" }),
    );
    expect(closeAgentHarnessHostCapabilitiesMock).toHaveBeenCalledOnce();
  });

  it("reselects the Codex hook after resolving legacy openai-codex route state", async () => {
    const codexSideQuestionMock = registerCodexSideQuestionHarness({
      supports: (ctx) =>
        ctx.provider === "openai"
          ? { supported: true, priority: 100 }
          : { supported: false, reason: "openai only" },
    });
    resolveModelWithRegistryMock.mockReturnValue({
      provider: "openai",
      id: "gpt-5.5",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });
    resolveSessionAuthSelectionMock.mockResolvedValue({
      profileId: "openai-codex:user@example.test",
      source: "auto",
      routeRequirement: "subscription",
    });
    ensureAuthProfileStoreMock.mockReturnValue({
      version: 1,
      profiles: {
        "openai-codex:user@example.test": {
          type: "oauth",
          provider: "openai",
          access: "subscription-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        },
      },
      order: { openai: ["openai-codex:user@example.test"] },
    });
    resolveModelAsyncMock.mockResolvedValue({
      model: {
        provider: "openai",
        id: "gpt-5.5",
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
      },
    });
    getApiKeyForModelMock.mockResolvedValue({
      apiKey: "subscription-token",
      mode: "oauth",
      source: "profile:openai-codex:user@example.test",
      profileId: "openai-codex:user@example.test",
    });

    const result = await runSideQuestion({
      cfg: {
        auth: {
          order: {
            openai: ["openai-codex:user@example.test"],
          },
        },
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.5": {
                agentRuntime: { id: "codex" },
              },
            },
          },
        },
      } as never,
      provider: "openai-codex",
      model: "gpt-5.5",
      sessionKey: DEFAULT_SESSION_KEY,
    });

    expect(result).toEqual({ text: "Codex side answer." });
    expect(codexSideQuestionMock).toHaveBeenCalledTimes(1);
    const sideQuestionParams = mockArg(codexSideQuestionMock, 0, 0) as {
      provider?: string;
      authProfileId?: string;
      runtimeModel?: { api?: string; baseUrl?: string };
      preparedRuntimeAuth?: {
        plan?: { modelRoute?: { api?: string; baseUrl?: string; authRequirement?: string } };
        authProfileStore?: { profiles?: Record<string, unknown> };
      };
    };
    expect(sideQuestionParams.provider).toBe("openai");
    expect(sideQuestionParams.authProfileId).toBe("openai-codex:user@example.test");
    expect(sideQuestionParams.runtimeModel).toMatchObject({
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    });
    expect(sideQuestionParams.preparedRuntimeAuth?.plan?.modelRoute).toMatchObject({
      api: sideQuestionParams.runtimeModel?.api,
      baseUrl: sideQuestionParams.runtimeModel?.baseUrl,
      authRequirement: "subscription",
    });
    expect(
      Object.keys(sideQuestionParams.preparedRuntimeAuth?.authProfileStore?.profiles ?? {}),
    ).toEqual(["openai-codex:user@example.test"]);
    expect(streamSimpleMock).not.toHaveBeenCalled();
    expect(registerProviderStreamForModelMock).not.toHaveBeenCalled();
  });

  it("prepares deny-all sender policy before calling a plugin side-question hook", async () => {
    const codexSideQuestionMock = registerCodexSideQuestionHarness();
    mockOpenAIPlatformProfile();
    resolveModelWithRegistryMock.mockReturnValue({
      provider: "openai",
      id: "gpt-5.5",
      api: "openai-responses",
    });
    resolveModelAsyncMock.mockResolvedValue({
      model: {
        provider: "openai",
        id: "gpt-5.5",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      },
    });
    await runSideQuestion({
      cfg: {
        channels: {
          telegram: {
            groups: {
              "deny-room": {
                toolsBySender: {
                  "id:restricted-sender": { deny: ["*"] },
                },
              },
            },
          },
        },
      } as never,
      provider: "openai",
      model: "gpt-5.5",
      sessionKey: "agent:main:telegram:group:deny-room",
      messageProvider: "telegram",
      groupId: "deny-room",
      senderId: "restricted-sender",
    });

    expect(codexSideQuestionMock).toHaveBeenCalledOnce();
    expect(mockArg(codexSideQuestionMock, 0, 0)).toMatchObject({ toolsAllow: [] });
  });

  it("does not fall back to the direct provider call when Codex lacks BTW support", async () => {
    registerAgentHarness({
      id: "codex",
      label: "Codex test harness",
      supports: () => ({ supported: true, priority: 100 }),
      runAttempt: vi.fn(),
    });

    await expect(
      runSideQuestion({
        provider: "openai",
        model: "gpt-5.5",
        sessionKey: DEFAULT_SESSION_KEY,
      }),
    ).rejects.toThrow('Selected agent harness "codex" does not support /btw side questions.');
    expect(streamSimpleMock).not.toHaveBeenCalled();
    expect(registerProviderStreamForModelMock).not.toHaveBeenCalled();
  });

  it("loads a cold Copilot harness before selecting the /btw provider fallback", async () => {
    let loaded = false;
    ensureSelectedAgentHarnessPluginMock.mockImplementation(async () => {
      if (loaded) {
        return;
      }
      loaded = true;
      registerAgentHarness({
        id: "copilot",
        label: "Copilot test harness",
        supports: () => ({ supported: true, priority: 100 }),
        runAttempt: vi.fn(),
      });
    });
    resolveModelWithRegistryMock.mockReturnValue({
      provider: "github-copilot",
      id: "gpt-4o",
      api: "openai-completions",
    });
    mockDoneAnswer("Copilot fallback answer.");

    const result = await runSideQuestion({
      cfg: {
        agents: {
          defaults: {
            models: {
              "github-copilot/gpt-4o": { agentRuntime: { id: "copilot" } },
            },
          },
        },
      } as never,
      provider: "github-copilot",
      model: "gpt-4o",
      sessionKey: DEFAULT_SESSION_KEY,
    });

    expect(result).toEqual({ text: "Copilot fallback answer." });
    expect(ensureSelectedAgentHarnessPluginMock).toHaveBeenCalledOnce();
    expect(ensureSelectedAgentHarnessPluginMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "github-copilot",
        modelId: "gpt-4o",
        config: expect.any(Object),
        agentId: "main",
        sessionKey: DEFAULT_SESSION_KEY,
        workspaceDir: "/tmp/workspace",
      }),
    );
    expect(streamSimpleMock).toHaveBeenCalledOnce();
  });

  it("runs CLI-runtime alias BTW as an ephemeral CLI side question", async () => {
    const { cleanup, prepared } = mockCliOutput({ text: "CLI side answer." });

    const result = await runSideQuestion({
      cfg: createCliRuntimeConfig(),
      model: "claude-opus-4-7",
      sessionKey: DEFAULT_SESSION_KEY,
      authorityRunId: "btw-cli-authority",
      opts: { runId: "parent-correlation" },
    });

    expect(result).toEqual({ text: "CLI side answer." });
    expect(prepareCliRunContextMock).toHaveBeenCalledTimes(1);
    const prepareParams = mockArg(prepareCliRunContextMock, 0, 0) as {
      executionMode?: string;
      provider?: string;
      model?: string;
      disableTools?: boolean;
      cliSessionId?: string;
      extraSystemPrompt?: string;
      prompt?: string;
    };
    expect(prepareParams.executionMode).toBe("side-question");
    expect(prepareParams.provider).toBe("claude-cli");
    expect(prepareParams.model).toBe("claude-opus-4-7");
    expect(prepareParams.disableTools).toBe(true);
    expect(prepareParams).toMatchObject({ runId: "btw-cli-authority" });
    expect(prepareParams.cliSessionId).toBeUndefined();
    expect(prepareParams.extraSystemPrompt).toContain("Answer only the side question");
    expect(prepareParams.prompt).toContain("<conversation_history>");
    expect(prepareParams.prompt).toContain("<btw_side_question>");
    expect(executePreparedCliRunMock).toHaveBeenCalledWith(prepared);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(getApiKeyForModelMock).not.toHaveBeenCalled();
    expect(streamSimpleMock).not.toHaveBeenCalled();
    expect(registerProviderStreamForModelMock).not.toHaveBeenCalled();
  });

  it.each([
    { options: { timeoutOverrideSeconds: 0 }, expected: MAX_TIMER_TIMEOUT_MS },
    { options: { timeoutOverrideMs: 0 }, expected: MAX_TIMER_TIMEOUT_MS },
    { options: { timeoutOverrideSeconds: 1800, timeoutOverrideMs: 1500 }, expected: 1500 },
  ])(
    "preserves the timeout override $options for CLI-runtime BTW",
    async ({ options, expected }) => {
      mockCliOutput({ text: "CLI side answer." });

      await runSideQuestion({
        cfg: createCliRuntimeConfig(),
        model: "claude-opus-4-7",
        opts: options,
        sessionKey: DEFAULT_SESSION_KEY,
      });

      const prepareParams = mockArg(prepareCliRunContextMock, 0, 0) as {
        timeoutMs?: unknown;
        runTimeoutOverrideMs?: unknown;
      };
      expect(prepareParams.timeoutMs).toBe(expected);
      expect(prepareParams.runTimeoutOverrideMs).toBe(expected);
    },
  );

  it("does not expose raw CLI BTW output when transformed text is empty", async () => {
    const { cleanup } = mockCliOutput({
      text: "   ",
      rawText: "raw untransformed answer",
    });

    await expect(
      runSideQuestion({
        cfg: createCliRuntimeConfig(),
        model: "claude-opus-4-7",
        sessionKey: DEFAULT_SESSION_KEY,
      }),
    ).rejects.toThrow("/btw side question via claude-cli produced no answer");

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(streamSimpleMock).not.toHaveBeenCalled();
  });

  it("does not let an auto-selected stale direct profile suppress auth-order CLI BTW", async () => {
    const { cleanup } = mockCliOutput({ text: "Claude CLI answer." });

    const result = await runSideQuestion({
      cfg: {
        auth: {
          order: { anthropic: ["anthropic:claude-cli"] },
          profiles: {
            "anthropic:api": { provider: "anthropic", mode: "api_key" },
            "anthropic:claude-cli": { provider: "claude-cli", mode: "oauth" },
          },
        },
      } as never,
      sessionEntry: createSessionEntry({
        authProfileOverride: "anthropic:api",
        authProfileOverrideSource: "auto",
      }),
    });

    expect(result).toEqual({ text: "Claude CLI answer." });
    const prepareParams = mockArg(prepareCliRunContextMock, 0, 0) as {
      provider?: string;
      authProfileId?: string;
      executionMode?: string;
    };
    expect(prepareParams.provider).toBe("claude-cli");
    expect(prepareParams.executionMode).toBe("side-question");
    expect(prepareParams.authProfileId).toBeUndefined();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(getApiKeyForModelMock).not.toHaveBeenCalled();
    expect(streamSimpleMock).not.toHaveBeenCalled();
  });

  it("preserves auto-selected session CLI BTW routing before resolving runtime auth", async () => {
    const { cleanup } = mockCliOutput({ text: "Session Claude CLI answer." });
    const sessionEntry = createSessionEntry({
      authProfileOverride: "anthropic:auto-cli",
      authProfileOverrideSource: "auto",
    });
    const sessionStore = { [DEFAULT_SESSION_KEY]: sessionEntry };
    resolveSessionAuthSelectionMock.mockImplementation(
      async (params: { sessionEntry?: SessionEntry }) => {
        if (params.sessionEntry) {
          params.sessionEntry.authProfileOverride = "anthropic:api";
          params.sessionEntry.authProfileOverrideSource = "auto";
        }
        return {
          profileId: "anthropic:api",
          source: "auto",
          routeRequirement: "api-key",
        };
      },
    );
    mockDoneAnswer("Generic fallback answer.");

    const result = await runSideQuestion({
      cfg: {
        auth: {
          order: { anthropic: ["anthropic:api"] },
          profiles: {
            "anthropic:api": { provider: "anthropic", mode: "api_key" },
            "anthropic:auto-cli": { provider: "claude-cli", mode: "oauth" },
          },
        },
      } as never,
      sessionEntry,
      sessionStore,
      sessionKey: DEFAULT_SESSION_KEY,
    });

    expect(result).toEqual({ text: "Session Claude CLI answer." });
    const prepareParams = mockArg(prepareCliRunContextMock, 0, 0) as {
      provider?: string;
      authProfileId?: string;
      executionMode?: string;
    };
    expect(prepareParams.provider).toBe("claude-cli");
    expect(prepareParams.executionMode).toBe("side-question");
    expect(prepareParams.authProfileId).toBe("anthropic:auto-cli");
    expect(resolveSessionAuthSelectionMock).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(getApiKeyForModelMock).not.toHaveBeenCalled();
    expect(streamSimpleMock).not.toHaveBeenCalled();
  });

  it("loads Claude CLI auth for BTW from persisted auth-store order", async () => {
    const staticAuthStore = {
      version: 1 as const,
      profiles: {},
      order: { anthropic: ["anthropic:claude-cli"] },
    };
    const claudeAuthStore = {
      version: 1 as const,
      profiles: {
        "anthropic:claude-cli": {
          type: "oauth" as const,
          provider: "claude-cli",
          access: "claude-cli-access",
          refresh: "claude-cli-refresh",
          expires: Date.now() + 60_000,
        },
      },
    };
    ensureAuthProfileStoreWithoutExternalProfilesMock.mockReturnValueOnce(staticAuthStore);
    ensureAuthProfileStoreMock.mockReturnValueOnce(claudeAuthStore);
    getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: "claude-cli-access",
      mode: "oauth",
      source: "profile:anthropic:claude-cli",
      profileId: "anthropic:claude-cli",
    });
    requireApiKeyMock.mockReturnValueOnce("claude-cli-access");
    resolveSessionAuthSelectionMock.mockResolvedValueOnce(undefined);
    resolveModelAsyncMock.mockResolvedValueOnce({
      model: {
        provider: DEFAULT_PROVIDER,
        id: DEFAULT_MODEL,
        api: "anthropic-messages",
      },
    });
    mockDoneAnswer("Claude CLI answer.");

    const result = await runSideQuestion();

    expect(result).toEqual({ text: "Claude CLI answer." });
    expect(ensureAuthProfileStoreWithoutExternalProfilesMock).toHaveBeenCalledWith(
      DEFAULT_AGENT_DIR,
      { allowKeychainPrompt: false },
    );
    expect(ensureAuthProfileStoreMock).toHaveBeenCalledWith(DEFAULT_AGENT_DIR, {
      externalCliProviderIds: ["claude-cli"],
      allowKeychainPrompt: false,
    });
    expect(getApiKeyForModelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: "anthropic:claude-cli",
        store: claudeAuthStore,
      }),
    );
  });

  it("rematerializes the direct model when automatic auth rotates to a SecretRef backup", async () => {
    const authStorage = { id: "btw-auth-storage" };
    const modelRegistry = { id: "btw-model-registry" };
    const authStore = {
      version: 1 as const,
      profiles: {
        "anthropic:primary": {
          type: "api_key" as const,
          provider: "anthropic",
          key: "primary-key",
        },
        "anthropic:backup": {
          type: "api_key" as const,
          provider: "anthropic",
          keyRef: {
            source: "file" as const,
            provider: "vault",
            id: "/anthropic/backup",
          },
        },
      },
      order: { anthropic: ["anthropic:primary", "anthropic:backup"] },
    };
    const rotatedModel = {
      provider: "anthropic",
      id: DEFAULT_MODEL,
      api: "anthropic-messages" as const,
      baseUrl: "https://backup.example.test",
      name: "Backup profile model",
    };
    discoverAuthStorageMock.mockReturnValue(authStorage);
    discoverModelsMock.mockReturnValue(modelRegistry);
    resolveModelWithRegistryMock.mockReturnValue({
      provider: "anthropic",
      id: DEFAULT_MODEL,
      api: "anthropic-messages",
      baseUrl: "https://primary.example.test",
      name: "Primary profile model",
    });
    resolveModelAsyncMock.mockResolvedValue({
      model: rotatedModel,
      authStorage,
      modelRegistry,
    });
    ensureAuthProfileStoreWithoutExternalProfilesMock.mockReturnValue(authStore);
    resolveSessionAuthSelectionMock.mockResolvedValue(undefined);
    getApiKeyForModelMock.mockImplementation(async (authParams: { profileId?: string } = {}) => {
      if (authParams.profileId === "anthropic:primary") {
        throw new Error("primary credential resolution failed");
      }
      if (authParams.profileId === "anthropic:backup") {
        return {
          apiKey: mintSecretSentinel("backup-secret", { label: "btw-backup" }),
          mode: "api-key",
          source: "profile:anthropic:backup",
          profileId: "anthropic:backup",
        };
      }
      throw new Error(`unexpected profile: ${authParams.profileId ?? "none"}`);
    });
    requireApiKeyMock.mockReturnValue("backup-secret");
    mockDoneAnswer("Backup answer.");

    await expect(
      runSideQuestion({
        cfg: {
          secrets: {
            providers: {
              vault: { source: "file", path: "/tmp/btw-secrets.json", mode: "json" },
            },
          },
        } as never,
      }),
    ).resolves.toEqual({ text: "Backup answer." });

    expect(
      getApiKeyForModelMock.mock.calls.map(
        ([authParams]) => (authParams as { profileId?: string }).profileId,
      ),
    ).toEqual(["anthropic:primary", "anthropic:backup"]);
    expect(resolveModelAsyncMock).toHaveBeenCalledWith(
      "anthropic",
      DEFAULT_MODEL,
      DEFAULT_AGENT_DIR,
      expect.any(Object),
      expect.objectContaining({
        authStorage,
        modelRegistry,
        authProfileId: "anthropic:backup",
        authProfileMode: "api_key",
        preparedModelRuntime: expect.objectContaining({
          configuredRuntimeModels: [],
          inlineProviderModels: [],
        }),
        skipAgentDiscovery: true,
      }),
    );
    const preparedAuthContext = expectRecordFields(
      (mockArg(prepareProviderRuntimeAuthMock, 0, 0) as { context?: unknown }).context,
      {
        provider: "anthropic",
        modelId: DEFAULT_MODEL,
        model: rotatedModel,
        profileId: "anthropic:backup",
      },
    );
    expect(preparedAuthContext.apiKey).toBe("backup-secret");
    expectRecordFields(mockArg(streamSimpleMock, 0, 0), {
      name: "Backup profile model",
      baseUrl: "https://backup.example.test",
    });
  });

  it("falls through an unresolved subscription route to the ordered Platform route", async () => {
    const authStorage = { id: "btw-openai-auth-storage" };
    const modelRegistry = { id: "btw-openai-model-registry" };
    const subscriptionModel = {
      provider: "openai",
      id: "gpt-5.5",
      api: "openai-chatgpt-responses" as const,
      baseUrl: "https://chatgpt.com/backend-api/codex",
      name: "Subscription model",
    };
    const platformModel = {
      provider: "openai",
      id: "gpt-5.5",
      api: "openai-responses" as const,
      baseUrl: "https://api.openai.com/v1",
      name: "Platform model",
    };
    const authStore = {
      version: 1 as const,
      profiles: {
        "openai:subscription": {
          type: "token" as const,
          provider: "openai",
          token: "unresolved-subscription-token",
          expires: Date.now() + 60_000,
        },
        "openai:platform": {
          type: "api_key" as const,
          provider: "openai",
          key: "platform-key",
        },
      },
      order: { openai: ["openai:subscription", "openai:platform"] },
    };
    discoverAuthStorageMock.mockReturnValue(authStorage);
    discoverModelsMock.mockReturnValue(modelRegistry);
    resolveModelWithRegistryMock.mockReturnValue(platformModel);
    resolveModelAsyncMock.mockImplementation(
      async (
        _provider: string,
        _modelId: string,
        _agentDir: string,
        _config: unknown,
        options?: { authProfileId?: string },
      ) => ({
        model: options?.authProfileId === "openai:subscription" ? subscriptionModel : platformModel,
        authStorage,
        modelRegistry,
      }),
    );
    ensureAuthProfileStoreMock.mockReturnValue(authStore);
    resolveSessionAuthSelectionMock.mockResolvedValue(undefined);
    getApiKeyForModelMock.mockImplementation(async (authParams: { profileId?: string } = {}) => {
      if (authParams.profileId === "openai:subscription") {
        throw new Error("subscription credential resolution failed");
      }
      if (authParams.profileId === "openai:platform") {
        return {
          apiKey: "platform-key",
          mode: "api-key",
          source: "profile:openai:platform",
          profileId: "openai:platform",
        };
      }
      throw new Error(`unexpected profile: ${authParams.profileId ?? "none"}`);
    });
    requireApiKeyMock.mockReturnValue("platform-key");
    mockDoneAnswer("Platform fallback answer.");

    await expect(
      runSideQuestion({
        cfg: {
          auth: {
            order: { openai: ["openai:subscription", "openai:platform"] },
          },
          agents: {
            defaults: {
              models: {
                "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } },
              },
            },
          },
        } as never,
        provider: "openai",
        model: "gpt-5.5",
      }),
    ).resolves.toEqual({ text: "Platform fallback answer." });

    expect(
      getApiKeyForModelMock.mock.calls.map(
        ([authParams]) => (authParams as { profileId?: string }).profileId,
      ),
    ).toEqual(["openai:subscription", "openai:platform"]);
    expect(
      resolveModelAsyncMock.mock.calls.map(
        (call) => (call[4] as { authProfileId?: string }).authProfileId,
      ),
    ).toEqual([undefined, "openai:subscription", "openai:platform"]);
    expectRecordFields(mockArg(streamSimpleMock, 0, 0), {
      name: "Platform model",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });
  });

  it("uses a same-route literal fallback only after its prepared profile tier fails", async () => {
    const platformModel = {
      provider: "openai",
      id: "gpt-5.5",
      api: "openai-responses" as const,
      baseUrl: "https://api.openai.com/v1",
      name: "Platform model",
    };
    const authStore = {
      version: 1 as const,
      profiles: {
        "openai:broken": {
          type: "api_key" as const,
          provider: "openai",
          key: "broken-profile-key",
        },
      },
      order: { openai: ["openai:broken"] },
    };
    resolveModelWithRegistryMock.mockReturnValue(platformModel);
    resolveModelAsyncMock.mockResolvedValue({ model: platformModel });
    ensureAuthProfileStoreMock.mockReturnValue(authStore);
    resolveSessionAuthSelectionMock.mockResolvedValue(undefined);
    resolveProviderEntryApiKeyProfileReferenceMock.mockReturnValue({ kind: "literal" });
    getApiKeyForModelMock.mockImplementation(
      async (authParams: { profileId?: string; allowAuthProfileFallback?: boolean }) => {
        if (authParams.profileId === "openai:broken") {
          throw new Error("profile key could not be resolved");
        }
        if (authParams.profileId === undefined && authParams.allowAuthProfileFallback === false) {
          return {
            apiKey: "literal-key",
            mode: "api-key",
            source: "models.json",
          };
        }
        throw new Error("unexpected auth lookup");
      },
    );
    requireApiKeyMock.mockReturnValue("literal-key");
    mockDoneAnswer("Literal fallback answer.");

    await expect(
      runSideQuestion({
        cfg: {
          auth: { order: { openai: ["openai:broken"] } },
          models: {
            providers: {
              openai: { apiKey: "literal-key" },
            },
          },
          agents: {
            defaults: {
              models: {
                "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } },
              },
            },
          },
        } as never,
        provider: "openai",
        model: "gpt-5.5",
      }),
    ).resolves.toEqual({ text: "Literal fallback answer." });

    expect(
      getApiKeyForModelMock.mock.calls.map(([authParams]) => {
        const lookup = authParams as {
          profileId?: string;
          allowAuthProfileFallback?: boolean;
        };
        return {
          profileId: lookup.profileId,
          allowAuthProfileFallback: lookup.allowAuthProfileFallback,
        };
      }),
    ).toEqual([
      { profileId: "openai:broken", allowAuthProfileFallback: undefined },
      { profileId: undefined, allowAuthProfileFallback: false },
    ]);
    expectRecordFields(mockArg(streamSimpleMock, 0, 0), {
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });
  });

  it.each([
    { label: "explicit", source: "user" as const },
    { label: "legacy source-less", source: undefined },
  ])("keeps $label user-pinned static Anthropic auth first for BTW", async ({ source }) => {
    const staticAuthStore = {
      version: 1 as const,
      profiles: {
        "anthropic:api": {
          type: "api_key" as const,
          provider: "anthropic",
          key: "static-key",
        },
      },
    };
    ensureAuthProfileStoreMock.mockReturnValueOnce(staticAuthStore);
    getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: "static-key",
      mode: "api-key",
      source: "profile:anthropic:api",
      profileId: "anthropic:api",
    });
    requireApiKeyMock.mockReturnValueOnce("static-key");
    resolveSessionAuthSelectionMock.mockResolvedValueOnce({
      profileId: "anthropic:api",
      source: "user",
      routeRequirement: "api-key",
    });
    mockDoneAnswer("Static answer.");

    await runSideQuestion({
      cfg: {
        auth: {
          order: { anthropic: ["anthropic:claude-cli"] },
          profiles: {
            "anthropic:api": { provider: "anthropic", mode: "api_key" },
            "anthropic:claude-cli": { provider: "claude-cli", mode: "oauth" },
          },
        },
      } as never,
      sessionEntry: createSessionEntry({
        authProfileOverride: "anthropic:api",
        authProfileOverrideSource: source,
      }),
    });

    expect(ensureAuthProfileStoreWithoutExternalProfilesMock).not.toHaveBeenCalled();
    expect(ensureAuthProfileStoreMock).toHaveBeenCalledWith(DEFAULT_AGENT_DIR, {
      profileId: "anthropic:api",
      externalCliProviderIds: ["claude-cli"],
      allowKeychainPrompt: false,
    });
    expectRecordFields(mockArg(getApiKeyForModelMock, 0, 0), {
      profileId: "anthropic:api",
      store: staticAuthStore,
    });
    expectRecordFields(
      (mockArg(prepareProviderRuntimeAuthMock, 0, 0) as { context?: unknown }).context,
      {
        profileId: "anthropic:api",
        authMode: "api-key",
      },
    );
  });

  it("applies provider runtime auth before streaming github-copilot BTW questions", async () => {
    resolveModelWithRegistryMock.mockReturnValue({
      provider: "github-copilot",
      id: "gpt-5.4",
      api: "openai-responses",
      baseUrl: "https://api.individual.githubcopilot.com",
    });
    resolveModelAsyncMock.mockResolvedValue({
      model: {
        provider: "github-copilot",
        id: "gpt-5.4",
        api: "openai-responses",
        baseUrl: "https://api.individual.githubcopilot.com",
      },
    });
    getApiKeyForModelMock.mockResolvedValue({
      apiKey: "github-token",
      mode: "token",
      source: "profile",
      profileId: "github-copilot:github",
    });
    requireApiKeyMock.mockReturnValue("github-token");
    prepareProviderRuntimeAuthMock.mockResolvedValue({
      apiKey: "copilot-runtime-token",
      baseUrl: "https://api.enterprise.githubcopilot.com",
    });
    mockDoneAnswer("Copilot answer.");

    const result = await runSideQuestion({
      provider: "github-copilot",
      model: "gpt-5.4",
    });

    expect(result).toEqual({ text: "Copilot answer." });
    const runtimeAuthParams = expectRecordFields(mockArg(prepareProviderRuntimeAuthMock, 0, 0), {
      provider: "github-copilot",
      workspaceDir: "/tmp/workspace",
    });
    expectRecordFields(runtimeAuthParams.context, {
      provider: "github-copilot",
      modelId: "gpt-5.4",
      workspaceDir: "/tmp/workspace",
      apiKey: "github-token",
      authMode: "token",
      profileId: "github-copilot:github",
    });
    const [streamModel, , streamOptions] = mockCall(streamSimpleMock);
    expectRecordFields(streamModel, {
      provider: "github-copilot",
      id: "gpt-5.4",
      baseUrl: "https://api.enterprise.githubcopilot.com",
    });
    const streamKey = (streamOptions as { apiKey?: string }).apiKey ?? "";
    expect(looksLikeSecretSentinel(streamKey)).toBe(true);
    expect(streamKey).not.toBe("copilot-runtime-token");
    expect(resolveSecretSentinel(streamKey)).toBe("copilot-runtime-token");
  });

  it("uses the provider's stream fn when registered so provider URL construction runs (#68336)", async () => {
    // Regression: before this fix, /btw called streamSimple directly and
    // bypassed the provider's createStreamFn/wrapStreamFn hooks. That caused
    // Ollama Cloud (api: "openai-completions", baseUrl: "https://ollama.com/")
    // to hit the marketing site instead of /v1/chat/completions.
    resolveModelWithRegistryMock.mockReturnValue({
      provider: "ollama",
      id: "glm-5.1",
      api: "openai-completions",
      baseUrl: "https://ollama.com/",
    });
    const providerStreamFn = vi
      .fn()
      .mockReturnValue(makeAsyncEvents([createDoneEvent("Ollama Cloud answer.")]));
    registerProviderStreamForModelMock.mockReturnValue(providerStreamFn);

    const result = await runSideQuestion({ provider: "ollama", model: "glm-5.1" });

    expect(result).toEqual({ text: "Ollama Cloud answer." });
    const registerParams = expectRecordFields(mockArg(registerProviderStreamForModelMock, 0, 0), {
      workspaceDir: "/tmp/workspace",
      wrapProviderStream: true,
    });
    expectRecordFields(registerParams.model, {
      provider: "ollama",
      api: "openai-completions",
      baseUrl: "https://ollama.com/",
    });
    expect(providerStreamFn).toHaveBeenCalledTimes(1);
    expect(streamSimpleMock).not.toHaveBeenCalled();
  });

  it("routes MiniMax Anthropic fallback streams through the embedded resolver", async () => {
    resolveModelWithRegistryMock.mockReturnValue({
      provider: "minimax-portal",
      id: "MiniMax-M2.7",
      api: "anthropic-messages",
      baseUrl: "https://api.minimax.io/anthropic",
      maxTokens: 196_608,
    });
    registerProviderStreamForModelMock.mockReturnValue(undefined);
    const resolvedStreamFn = vi
      .fn()
      .mockReturnValue(makeAsyncEvents([createDoneEvent("MiniMax answer.")]));
    resolveEmbeddedAgentStreamMock.mockReturnValueOnce({
      streamFn: resolvedStreamFn,
      strategy: "boundary-aware:anthropic-messages",
    });

    const result = await runSideQuestion({
      provider: "minimax-portal",
      model: "MiniMax-M2.7",
    });

    expect(result).toEqual({ text: "MiniMax answer." });
    const resolverParams = expectRecordFields(mockArg(resolveEmbeddedAgentStreamMock, 0, 0), {
      sessionId: "session-1",
      resolvedApiKey: "secret",
      authProfileId: undefined,
    });
    expect(resolverParams.providerStreamFn).toBeUndefined();
    expectRecordFields(resolverParams.model, {
      provider: "minimax-portal",
      id: "MiniMax-M2.7",
      api: "anthropic-messages",
      maxTokens: 196_608,
    });
    expect(resolvedStreamFn).toHaveBeenCalledTimes(1);
    expect(streamSimpleMock).not.toHaveBeenCalled();
  });

  it("strips injected empty tools arrays from BTW payloads before sending", async () => {
    mockDoneAnswer("Final answer.");

    await runSideQuestion();

    const options = mockArg(streamSimpleMock, 0, 2);
    const onPayload = (options as { onPayload?: (payload: unknown) => void })?.onPayload;
    const payloadWithEmptyTools = { messages: [], tools: [] as unknown[] };

    const result = onPayload?.(payloadWithEmptyTools);

    expect(payloadWithEmptyTools).not.toHaveProperty("tools");
    expect(result).toBeUndefined();
  });

  it("allows Bedrock /btw runs to proceed without a static api key in aws-sdk mode", async () => {
    resolveModelWithRegistryMock.mockReturnValue({
      provider: "amazon-bedrock",
      id: "us.anthropic.claude-sonnet-4-5-v1:0",
      api: "anthropic-messages",
    });
    getApiKeyForModelMock.mockResolvedValue({
      apiKey: undefined,
      mode: "aws-sdk",
      source: "aws-sdk default chain",
    });
    streamSimpleMock.mockReturnValue(makeAsyncEvents([createDoneEvent("Bedrock answer.")]));

    const result = await runSideQuestion({
      cfg: {},
      provider: "amazon-bedrock",
      model: "us.anthropic.claude-sonnet-4-5-v1:0",
    });

    expect(result).toEqual({ text: "Bedrock answer." });
    expect(requireApiKeyMock).not.toHaveBeenCalled();
    const options = streamSimpleMock.mock.calls.at(-1)?.[2];
    expect((options as { apiKey?: string } | undefined)?.apiKey).toBeUndefined();
  });

  it("forces provider reasoning off even when the session think level is adaptive", async () => {
    streamSimpleMock.mockImplementation((_model, _input, options?: { reasoning?: unknown }) => {
      return options?.reasoning === undefined
        ? makeAsyncEvents([createDoneEvent("Final answer.")])
        : makeAsyncEvents([createThinkingOnlyDoneEvent("thinking only")]);
    });

    const result = await runSideQuestion({ resolvedThinkLevel: "adaptive" });

    expect(result).toEqual({ text: "Final answer." });
    const options = mockArg(streamSimpleMock, 0, 2);
    expect((options as { reasoning?: unknown } | undefined)?.reasoning).toBeUndefined();
  });

  it("fails when the current branch has no messages", async () => {
    clearBuiltSessionMessages();
    streamSimpleMock.mockReturnValue(makeAsyncEvents([]));

    await expect(runSideQuestion()).rejects.toThrow("No active session context.");
  });

  it("uses active-run snapshot messages for BTW context while the main run is in flight", async () => {
    clearBuiltSessionMessages();
    getActiveEmbeddedRunSnapshotMock.mockReturnValue({
      transcriptLeafId: "assistant-1",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "write some things then wait 30 seconds and write more" },
          ],
          timestamp: 1,
        },
      ],
    });
    mockDoneAnswer(MATH_ANSWER);

    const result = await runMathSideQuestion();

    expect(result).toEqual({ text: MATH_ANSWER });
    const context = streamContext();
    expect(String(context.systemPrompt)).toContain("ephemeral /btw side question");
    const messages = contextMessages(context);
    expect(messages.some((message) => message.role === "user")).toBe(true);
    const sideQuestionMessage = messages.find(
      (message) =>
        message.role === "user" &&
        firstTextBlockIncludes(
          message,
          `<btw_side_question>\n${MATH_QUESTION}\n</btw_side_question>`,
        ),
    );
    if (!sideQuestionMessage) {
      throw new Error("Expected BTW side question message");
    }
  });

  it("uses the in-flight prompt as background only when there is no prior transcript context", async () => {
    clearBuiltSessionMessages();
    getActiveEmbeddedRunSnapshotMock.mockReturnValue({
      transcriptLeafId: null,
      messages: [],
      inFlightPrompt: "build me a tic-tac-toe game in brainfuck",
    });
    mockDoneAnswer("You're building a tic-tac-toe game in Brainfuck.");

    const result = await runSideQuestion({ question: "what are we doing?" });

    expect(result).toEqual({ text: "You're building a tic-tac-toe game in Brainfuck." });
    const [message] = contextMessages(streamContext());
    expectRecordFields(message, { role: "user" });
    expectTextBlockContains(
      expectDefined(
        (expectDefined(message, "message test invariant").content as Array<unknown>)[0],
        "(message.content as Array<unknown>)[0] test invariant",
      ),
      "<in_flight_main_task>\nbuild me a tic-tac-toe game in brainfuck\n</in_flight_main_task>",
    );
  });

  it("wraps the side question so the model does not treat it as a main-task continuation", async () => {
    mockDoneAnswer("About 93 million miles.");

    await runSideQuestion({ question: "what is the distance to the sun?" });

    const context = streamContext();
    expect(String(context.systemPrompt)).toContain(
      "Do not continue, resume, or complete any unfinished task",
    );
    const sideQuestionMessage = contextMessages(context).find(
      (message) =>
        message.role === "user" &&
        firstTextBlockIncludes(
          message,
          "Ignore any unfinished task in the conversation while answering it.",
        ),
    );
    if (!sideQuestionMessage) {
      throw new Error("Expected isolated side question message");
    }
  });

  it("branches away from an unresolved trailing user turn before building BTW context", async () => {
    const assistantEntry = createTranscriptEntry({
      id: "assistant-1",
      message: createAssistantTranscriptMessage([{ type: "text", text: "seed answer" }]),
    });
    const trailingUserEntry = createTranscriptEntry({
      id: "user-2",
      parentId: "assistant-1",
      message: createUserTranscriptMessage([{ type: "text", text: "unfinished task" }]),
    });
    mockTranscriptEntries([assistantEntry, trailingUserEntry]);
    mockDoneAnswer(MATH_ANSWER);

    const result = await runMathSideQuestion();

    expect(buildSessionContextMock).toHaveBeenCalledTimes(1);
    expect(buildSessionContextMock).toHaveBeenCalledWith([assistantEntry]);
    expect(result).toEqual({ text: MATH_ANSWER });
  });

  it("branches to the active run snapshot leaf when the session is busy", async () => {
    const { userEntry, assistantEntry } = createSeedTranscript();
    const newerEntry = createTranscriptEntry({
      id: "newer-user",
      parentId: "assistant-seed",
      message: createUserTranscriptMessage([{ type: "text", text: "newer unfinished task" }]),
    });
    mockTranscriptEntries([userEntry, assistantEntry, newerEntry]);
    getActiveEmbeddedRunSnapshotMock.mockReturnValue({
      transcriptLeafId: "assistant-seed",
    });
    mockDoneAnswer(MATH_ANSWER);

    const result = await runMathSideQuestion();

    expect(buildSessionContextMock).toHaveBeenCalledTimes(1);
    expect(buildSessionContextMock).toHaveBeenCalledWith([userEntry, assistantEntry]);
    expect(result).toEqual({ text: MATH_ANSWER });
  });

  it("reads SQLite marker transcripts through the accessor when no active snapshot exists", async () => {
    const header = {
      type: "session",
      version: 3,
      id: "session-1",
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: "/tmp",
    };
    const { userEntry, assistantEntry } = createSeedTranscript();
    loadTranscriptEventsMock.mockResolvedValue([header, userEntry, assistantEntry]);
    readFileMock.mockRejectedValue(new Error("sqlite marker must not be read as a file"));
    mockDoneAnswer(MATH_ANSWER);

    const result = await runMathSideQuestion({
      sessionKey: DEFAULT_SESSION_KEY,
      sessionEntry: createSessionEntry(),
      storePath: DEFAULT_STORE_PATH,
    });

    expect(result).toEqual({ text: MATH_ANSWER });
    expect(readFileMock).not.toHaveBeenCalled();
    expect(loadTranscriptEventsMock).toHaveBeenCalledWith({
      agentId: "main",
      sessionId: "session-1",
      sessionKey: DEFAULT_SESSION_KEY,
      storePath: DEFAULT_STORE_PATH,
    });
    expect(buildSessionContextMock).toHaveBeenCalledTimes(1);
    expect(buildSessionContextMock).toHaveBeenCalledWith([userEntry, assistantEntry]);
  });

  it("rejects a supplied session key that disagrees with an incomplete SQLite marker target", async () => {
    const markerStorePath = "/tmp/marker-sessions.sqlite";
    listSessionEntriesCoreMock.mockReturnValue([
      {
        sessionKey: "agent:main:matching",
        entry: createSessionEntry(),
      },
    ]);
    loadSessionEntryMock.mockReturnValue(createSessionEntry({ sessionId: "different-session" }));

    await expect(
      runMathSideQuestion({
        sessionEntry: createSessionEntry({
          sessionFile: `sqlite:main:session-1:${markerStorePath}`,
        }),
        storePath: undefined,
      }),
    ).rejects.toThrow("No active session context.");

    expect(listSessionEntriesCoreMock).toHaveBeenCalledWith({
      agentId: "main",
      projection: "list",
      storePath: markerStorePath,
    });
    expect(loadSessionEntryMock).toHaveBeenCalledWith({
      agentId: "main",
      sessionKey: DEFAULT_SESSION_KEY,
      storePath: markerStorePath,
    });
    expect(loadTranscriptEventsMock).not.toHaveBeenCalled();
  });

  it("falls back when the active run snapshot leaf no longer exists", async () => {
    const { userEntry, assistantEntry } = createSeedTranscript();
    mockTranscriptEntries([userEntry, assistantEntry]);
    getActiveEmbeddedRunSnapshotMock.mockReturnValue({
      transcriptLeafId: "assistant-gone",
    });
    mockDoneAnswer(MATH_ANSWER);

    const result = await runMathSideQuestion();

    expect(buildSessionContextMock).toHaveBeenCalledTimes(1);
    expect(buildSessionContextMock).toHaveBeenCalledWith([userEntry, assistantEntry]);
    expect(result).toEqual({ text: MATH_ANSWER });
    expect(diagDebugMock).toHaveBeenCalledWith(
      "btw snapshot leaf unavailable: sessionId=session-1 leaf=assistant-gone",
    );
  });

  it("honors an explicitly empty active run snapshot", async () => {
    const { userEntry, assistantEntry } = createSeedTranscript();
    mockTranscriptEntries([userEntry, assistantEntry]);
    getActiveEmbeddedRunSnapshotMock.mockReturnValue({
      transcriptLeafId: null,
    });

    await expect(runMathSideQuestion()).rejects.toThrow("No active session context.");

    expect(buildSessionContextMock).toHaveBeenCalledTimes(1);
    expect(buildSessionContextMock).toHaveBeenCalledWith([]);
  });

  it("keeps parentless history addressed by a terminal leaf control", async () => {
    const userEntry = {
      type: "message",
      id: "user-seed",
      message: createUserTranscriptMessage(),
    };
    const assistantEntry = {
      type: "message",
      id: "assistant-seed",
      message: createAssistantTranscriptMessage([{ type: "text", text: "seed answer" }]),
    };
    const sideEntry = createTranscriptEntry({
      id: "side-delivery",
      parentId: "assistant-seed",
      message: createAssistantTranscriptMessage([{ type: "text", text: "side delivery" }]),
    });
    const leafEntry = {
      type: "leaf",
      id: "active-leaf",
      parentId: "side-delivery",
      targetId: "assistant-seed",
    };
    mockTranscriptEntries([userEntry, assistantEntry, sideEntry, leafEntry]);
    mockDoneAnswer(MATH_ANSWER);

    const result = await runMathSideQuestion();

    expect(buildSessionContextMock).toHaveBeenCalledWith([
      { ...userEntry, parentId: null },
      { ...assistantEntry, parentId: "user-seed" },
    ]);
    expect(result).toEqual({ text: MATH_ANSWER });
  });

  it("keeps visible history after continuing from a disjoint opaque append cursor", async () => {
    const { userEntry, assistantEntry } = createSeedTranscript();
    const sideEntry = createTranscriptEntry({
      id: "side-delivery",
      parentId: "assistant-seed",
      message: createAssistantTranscriptMessage([{ type: "text", text: "side delivery" }]),
    });
    const metadataEntry = {
      type: "metadata",
      id: "plugin-metadata",
      parentId: "side-delivery",
    };
    const leafEntry = {
      type: "leaf",
      id: "active-leaf",
      parentId: "side-delivery",
      targetId: "assistant-seed",
      appendParentId: "plugin-metadata",
    };
    const continuationEntry = createTranscriptEntry({
      id: "assistant-continuation",
      parentId: "plugin-metadata",
      message: createAssistantTranscriptMessage([{ type: "text", text: "continued answer" }]),
    });
    mockTranscriptEntries([
      userEntry,
      assistantEntry,
      sideEntry,
      metadataEntry,
      leafEntry,
      continuationEntry,
    ]);
    mockDoneAnswer(MATH_ANSWER);

    const result = await runMathSideQuestion();

    expect(buildSessionContextMock).toHaveBeenCalledWith([
      userEntry,
      assistantEntry,
      { ...continuationEntry, parentId: "assistant-seed" },
    ]);
    expect(result).toEqual({ text: MATH_ANSWER });
  });

  it("excludes tool results from BTW context to avoid replaying raw tool output", async () => {
    mockActiveTranscript([
      createUserTranscriptMessage(),
      {
        role: "toolResult",
        content: [{ type: "text", text: "sensitive tool output" }],
        details: { raw: "secret" },
        timestamp: 2,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        timestamp: 3,
      },
    ]);
    mockDoneAnswer(MATH_ANSWER);

    await runMathSideQuestion();

    const messages = contextMessages(streamContext());
    expect(messages).toHaveLength(3);
    expectRecordFields(messages[0], { role: "user" });
    expectRecordFields(messages[1], { role: "assistant" });
    expectRecordFields(messages[2], { role: "user" });
    expect(messages.some((message) => message.role === "toolResult")).toBe(false);
  });

  it("strips assistant tool calls from fallback BTW context so stale calls are not replayed", async () => {
    mockActiveTranscript([
      createUserTranscriptMessage(),
      createAssistantTranscriptMessage(
        [
          { type: "text", text: "Let me check." },
          { type: "toolCall", id: "call_1", name: "read", arguments: { path: "README.md" } },
          { type: "toolUse", id: "call_legacy", name: "read", input: { path: "README.md" } },
          { type: "tool_call", id: "call_snake", name: "read", arguments: { path: "README.md" } },
        ],
        { stopReason: "toolUse" },
      ),
    ]);
    mockDoneAnswer(MATH_ANSWER);

    await runMathSideQuestion();

    const context = streamContext();
    expectSanitizedAssistantContext(context, "Let me check.");
  });

  it("drops assistant messages that contain only tool calls", async () => {
    mockActiveTranscript([
      createUserTranscriptMessage(),
      createAssistantTranscriptMessage(
        [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
        { stopReason: "toolUse", output: 0 },
      ),
    ]);

    const context = await runMathSideQuestionAndCaptureContext();

    expectNoAssistantMessages(context);
  });

  it("strips embedded user tool results from BTW context", async () => {
    mockActiveTranscript([
      createUserTranscriptMessage([
        { type: "text", text: "seed" },
        {
          type: "toolResult",
          toolUseId: "call_1",
          content: [{ type: "text", text: "secret" }],
        },
        {
          type: "tool_result",
          toolUseId: "call_2",
          content: [{ type: "text", text: "secret-2" }],
        },
      ]),
    ]);

    const context = await runMathSideQuestionAndCaptureContext();
    expectSeedOnlyUserContext(context);
  });

  it("drops assistant thinking blocks from BTW context", async () => {
    mockActiveTranscript([
      createUserTranscriptMessage(),
      createAssistantTranscriptMessage(
        [
          { type: "text", text: "Visible answer" },
          { type: "thinking", thinking: "Hidden chain of thought" },
        ],
        { output: 1 },
      ),
    ]);

    const context = await runMathSideQuestionAndCaptureContext();

    expectSanitizedAssistantContext(context, "Visible answer");
  });

  it("drops thinking-only assistant messages from BTW context", async () => {
    mockActiveTranscript([
      createUserTranscriptMessage(),
      createAssistantTranscriptMessage(
        [{ type: "thinking", thinking: "Hidden chain of thought" }],
        { output: 1 },
      ),
    ]);

    const context = await runMathSideQuestionAndCaptureContext();

    expectNoAssistantMessages(context);
  });

  it("drops malformed user image blocks from BTW context", async () => {
    mockActiveTranscript([
      createUserTranscriptMessage([
        { type: "text", text: "seed" },
        { type: "image", mimeType: "image/png" },
      ]),
    ]);

    const context = await runMathSideQuestionAndCaptureContext();
    expectSeedOnlyUserContext(context);
  });

  it("normalizes malformed assistant content before stripping tool blocks", async () => {
    mockActiveTranscript([
      createUserTranscriptMessage(),
      createAssistantTranscriptMessage(
        { type: "toolCall", id: "call_1", name: "read", arguments: {} },
        { stopReason: "toolUse", output: 0 },
      ),
    ]);

    const context = await runMathSideQuestionAndCaptureContext();

    expectNoAssistantMessages(context);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
