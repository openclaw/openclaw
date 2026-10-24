import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../auto-reply/reply-payload.js";
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
import { executePreparedCliRunMock } from "./btw.mocks.test-support.js";
import * as btw from "./btw.test-support.js";
import { testing as cliBackendsTesting } from "./cli-backends.test-support.js";
import {
  createModelGenerationFixture,
  publishCurrentModelGeneration,
} from "./embedded-agent-runner/model.generation-scope.test-support.js";
import type { AgentHarness } from "./harness/types.js";

function createSeedTranscript() {
  const userEntry = btw.createTranscriptEntry({
    id: "user-seed",
    message: btw.createUserTranscriptMessage(),
  });
  const assistantEntry = btw.createTranscriptEntry({
    id: "assistant-seed",
    parentId: "user-seed",
    message: btw.createAssistantTranscriptMessage([{ type: "text", text: "seed answer" }]),
  });
  return { userEntry, assistantEntry };
}

describe("runBtwSideQuestion", () => {
  btw.setupBtwTestHooks();

  it.each([
    { name: "text-end drain", boundary: "text_end", maxChars: 200 },
    { name: "incremental drain", boundary: "text_end", maxChars: 5 },
    { name: "message-end drain", boundary: "message_end", maxChars: 5 },
  ] as const)(
    "contains failed block delivery, continues the $name, and preserves the final answer",
    async ({ boundary, maxChars }) => {
      const failure = new Error("Block delivery rejected");
      const onBlockReply = vi
        .fn(async (_payload: ReplyPayload) => {})
        .mockRejectedValueOnce(failure);
      btw.streamSimpleMock.mockReturnValue(
        btw.makeAsyncEvents([
          ...["one", "two", "three"].flatMap((text) => [
            { type: "text_delta", delta: `${text}\n\n` },
            { type: "text_end" },
          ]),
          btw.createDoneEvent("one\n\ntwo\n\nthree"),
        ]),
      );

      await expect(
        btw.runSideQuestion({
          blockReplyChunking: { minChars: 1, maxChars, breakPreference: "paragraph" },
          resolvedBlockStreamingBreak: boundary,
          opts: { onBlockReply },
        }),
      ).resolves.toEqual({ text: "one\n\ntwo\n\nthree" });
      expect(onBlockReply.mock.calls.map(([payload]) => payload.text?.trim())).toEqual([
        "one",
        "two",
        "three",
      ]);
    },
  );

  it("joins pending block delivery before releasing a failed BTW stream", async () => {
    const started = createDeferredCore();
    const finishBlock = createDeferredCore();
    const streamError = new Error("Provider stream failed");
    const deliveryError = new Error("Pending block delivery failed");
    btw.streamSimpleMock.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield { type: "text_delta", delta: "one" };
        yield { type: "text_end" };
        throw streamError;
      },
    });
    let settled = false;
    const outcome = btw
      .runSideQuestion({
        blockReplyChunking: { minChars: 1, maxChars: 200 },
        resolvedBlockStreamingBreak: "text_end",
        opts: {
          onBlockReply: async () => {
            started.resolve();
            await finishBlock.promise;
            throw deliveryError;
          },
        },
      })
      .then(
        () => {
          settled = true;
          return undefined;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
    try {
      await started.promise;
      // Let the failed stream settle without a timed delay or polling.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(settled).toBe(false);
    } finally {
      finishBlock.resolve();
      expect(await outcome).toBe(streamError);
    }
  });

  it.each(["off", "stream"] as const)(
    "keeps admitted %s reasoning visibility when caller input changes",
    async (mode) => {
      const onReasoningStream = vi.fn();
      const onReasoningEnd = vi.fn();
      const input = btw.createSideQuestionParams({
        resolvedReasoningLevel: mode,
        opts: {
          onAssistantMessageStart: async () => {
            input.resolvedReasoningLevel = mode === "off" ? "on" : "off";
          },
          onReasoningStream,
          onReasoningEnd,
        },
      });
      const done = btw.createDoneEvent("Final answer.");
      btw.streamSimpleMock.mockReturnValue(
        btw.makeAsyncEvents([
          { type: "start", partial: done.message },
          { type: "thinking_delta", delta: "One " },
          { type: "thinking_delta", delta: "two" },
          { type: "thinking_end" },
          done,
        ]),
      );

      await expect(btw.runBtwSideQuestion(input)).resolves.toEqual({ text: "Final answer." });
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
    { harness: "codex", sandboxSessionKey: "agent:main:policy" },
  ])(
    "retains the selected global agent for $harness with policy $sandboxSessionKey",
    async ({ harness, sandboxSessionKey }) => {
      // Gateway startup publishes configured owners with allowGatewaySubagentBinding
      // (server-startup-post-attach.ts), and that flag is part of the owner key
      // (prepared-model-runtime.owner.ts). A gateway-hosted BTW request that omits
      // it matches no owner, and standalone activation is refused while the gateway
      // lifecycle is active, so the side question fails with "owner was not published".
      btw.mockDoneAnswer("Final answer.");
      btw.resolveSessionAgentIdMock.mockImplementation(
        (await vi.importActual<typeof import("./agent-scope.js")>("./agent-scope.js"))
          .resolveSessionAgentId,
      );
      const sideQuestion = harness === "codex" ? btw.registerCodexSideQuestionHarness() : undefined;

      await btw.runSideQuestion({
        agentId: "work",
        cfg: {
          agents: { ownership: "explicit", entries: { main: {}, work: {} } },
          session: { scope: "global" },
        },
        sessionKey: "global",
        sandboxSessionKey,
        allowGatewaySubagentBinding: true,
      });

      expect(btw.mockCall(btw.loadPreparedModelRuntimeSnapshotMock)?.[0]).toMatchObject({
        agentDir: btw.DEFAULT_AGENT_DIR,
        agentId: "work",
        allowGatewaySubagentBinding: true,
      });
      expect(btw.resolveSessionAuthSelectionMock).toHaveBeenCalledWith(
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
    btw.mockDoneAnswer("Final answer.");

    await btw.runSideQuestion();

    expect(btw.mockCall(btw.loadPreparedModelRuntimeSnapshotMock)?.[0]).not.toHaveProperty(
      "allowGatewaySubagentBinding",
    );
  });

  it.each(["harness cleanup", "harness error", "stream output and transport"] as const)(
    "keeps the source database through %s after its publication retires",
    async (mode) => {
      const file = btw.state.path(`btw-${mode.replaceAll(" ", "-")}.sqlite`);
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
      btw.snapshotResources.acquire = () => source.retain();
      const entered = createDeferredCore();
      const finish = createDeferredCore();
      const tailEntered = createDeferredCore();
      const finishTail = createDeferredCore();
      const owner = new AsyncWorkScope();
      let operation: Promise<unknown> | undefined;
      let tailValue: unknown;
      try {
        if (mode !== "stream output and transport") {
          const runHarness = btw.registerCodexSideQuestionHarness();
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
          operation = owner.track(() => btw.runSideQuestion());
        } else {
          btw.streamSimpleMock.mockImplementationOnce(() => {
            void trackAsyncWork(async () => {
              tailEntered.resolve();
              await finishTail.promise;
              tailValue = database.prepare("SELECT value FROM answer").get()?.value;
            });
            return btw.makeAsyncEvents([
              { type: "text_start" },
              btw.createDoneEvent("The answer is 42."),
            ]);
          });
          operation = owner.track(() =>
            btw.runSideQuestion({
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
    const cfg = { agents: { entries: { main: {} } } };
    const generationA = createModelGenerationFixture({
      agentDir: btw.state.agentDir(),
      workspaceDir: btw.state.workspaceDir,
      config: cfg,
      label: "btw-a",
      provider: "local-proxy",
      requestProvider: "local-proxy",
      modelId: "side-model",
    });
    const generationB = createModelGenerationFixture({
      agentDir: btw.state.agentDir(),
      workspaceDir: btw.state.workspaceDir,
      config: cfg,
      label: "btw-b",
      provider: "local-proxy",
      requestProvider: "local-proxy",
      modelId: "side-model",
    });
    btw.preparedRuntimeSnapshotState.snapshot = generationA.preparedModelRuntime;
    btw.preparedRuntimeSnapshotState.useSnapshotPluginRegistry = true;
    btw.resolveAgentWorkspaceDirMock.mockReturnValue(btw.state.workspaceDir);
    publishCurrentModelGeneration(generationB);
    const runtimeAuthA = vi.fn(async () => ({ apiKey: "runtime-auth-a" }));
    const runtimeAuthB = vi.fn(async () => ({ apiKey: "runtime-auth-b" }));
    const streamA = vi.fn(
      (model: { name?: string }, _context: unknown, options?: { apiKey?: string }) => {
        const apiKey = options?.apiKey;
        const resolvedApiKey =
          apiKey && looksLikeSecretSentinel(apiKey) ? resolveSecretSentinel(apiKey) : apiKey;
        return btw.makeAsyncEvents([
          btw.createDoneEvent(`${model.name ?? "missing model"} / ${resolvedApiKey} / Stream A`),
        ]);
      },
    );
    const streamB = vi.fn(() =>
      btw.makeAsyncEvents([btw.createDoneEvent("Generation B / runtime-auth-b / Stream B")]),
    );
    const activeGenerationRegistry = () =>
      getPluginRuntimeGenerationRegistry() ?? getActivePluginRegistry();
    btw.resolveModelWithRegistryMock.mockImplementation(() => {
      const snapshot = getCurrentPluginMetadataSnapshot({
        config: cfg,
        workspaceDir: btw.state.workspaceDir,
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
    btw.prepareProviderRuntimeAuthMock.mockImplementation(async () =>
      activeGenerationRegistry() === generationA.pluginRegistry
        ? await runtimeAuthA()
        : await runtimeAuthB(),
    );
    btw.registerProviderStreamForModelMock.mockImplementation(() =>
      activeGenerationRegistry() === generationA.pluginRegistry ? streamA : streamB,
    );

    await expect(
      btw.runSideQuestion({ cfg, provider: "local-proxy", model: "side-model" }),
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
    expect(btw.streamSimpleMock).not.toHaveBeenCalled();
    expect(btw.registerProviderStreamForModelMock).toHaveBeenCalledWith(
      expect.objectContaining({ wrapProviderStream: true }),
    );
  });

  it("routes Codex-selected BTW questions through the harness side-question hook", async () => {
    const supports = vi.fn(btw.supportsPreparedOpenAIAuth);
    const codexSideQuestionMock = btw.registerCodexSideQuestionHarness({
      supports,
    });
    btw.resolveModelWithRegistryMock.mockReturnValue(btw.createOpenAIModel());
    btw.resolveSessionAuthSelectionMock.mockResolvedValue({
      profileId: "openai:work",
      source: "auto",
      routeRequirement: "subscription",
    });
    btw.ensureAuthProfileStoreMock.mockReturnValue({
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
    btw.resolveModelAsyncMock.mockImplementation(
      async (
        _provider: string,
        _modelId: string,
        _agentDir: string,
        _config: unknown,
        options?: { authProfileMode?: string },
      ) => ({
        model:
          options?.authProfileMode === "token"
            ? btw.createOpenAIModel(true)
            : btw.resolveModelWithRegistryMock(),
      }),
    );
    btw.getApiKeyForModelMock.mockResolvedValue({
      apiKey: "subscription-token",
      mode: "token",
      source: "profile:openai:work",
      profileId: "openai:work",
    });

    const requester = {
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
    };
    const result = await btw.runSideQuestion({
      ...requester,
      provider: "openai",
      model: "gpt-5.5",
      sessionKey: btw.DEFAULT_SESSION_KEY,
      authorityRunId: "btw-side-authority",
      opts: { runId: "parent-correlation" },
    });

    expect(result).toEqual({ text: "Codex side answer." });
    expect(codexSideQuestionMock).toHaveBeenCalledTimes(1);
    expect(codexSideQuestionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-5.5",
        question: btw.DEFAULT_QUESTION,
        sessionId: "session-1",
        agentId: "main",
        workspaceDir: "/tmp/workspace",
        authProfileId: "openai:work",
        ...requester,
        opts: { runId: "btw-side-authority" },
        runtimeModel: expect.objectContaining({
          api: "openai-chatgpt-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
        }),
      }),
    );
    expect(btw.mockArg(codexSideQuestionMock, 0, 0)).toHaveProperty(
      "hostCapabilities",
      btw.agentHarnessHostCapabilitiesMock,
    );
    expect(btw.createAgentHarnessHostCapabilitiesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: expect.objectContaining({
          admittedRunContext: expect.objectContaining({
            operationalRunInstance: expect.objectContaining({ runId: "btw-side-authority" }),
          }),
          runId: "btw-side-authority",
        }),
      }),
    );
    expect(btw.closeAgentHarnessHostCapabilitiesMock).toHaveBeenCalledOnce();
    expect(btw.resolveModelAsyncMock).toHaveBeenCalledWith(
      "openai",
      "gpt-5.5",
      btw.DEFAULT_AGENT_DIR,
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
      btw.mockArg(btw.resolveModelAsyncMock, 0, 4) as { preparedModelRuntime?: unknown }
    ).preparedModelRuntime;
    expect(btw.mockArg(codexSideQuestionMock, 0, 0)).toHaveProperty(
      "preparedModelRuntime",
      preparedModelRuntime,
    );
    expect(
      (btw.mockArg(codexSideQuestionMock, 0, 0) as { sessionFile?: string }).sessionFile,
    ).toContain("session-1.jsonl");
    expect(btw.streamSimpleMock).not.toHaveBeenCalled();
    expect(btw.registerProviderStreamForModelMock).not.toHaveBeenCalled();
    btw.expectPreparedAuthSupport(supports, {
      source: "profile",
      mode: "token",
      requirement: "subscription",
    });
  });

  it("exposes block-streamed side-question usage without mutating the parent session", async () => {
    const tokens = { input: 13, output: 9, cacheRead: 7, cacheWrite: 3 };
    const usage = { ...tokens, total: 41 };
    const cost = { input: 0.1, output: 0.1, cacheRead: 0.03, cacheWrite: 0.02, total: 0.25 };
    const text = "Side answer.";
    const onBlockReply = vi.fn().mockResolvedValue(undefined);
    const done = btw.createDoneEvent(text);
    done.message.usage = { ...tokens, totalTokens: 41, cost };
    btw.streamSimpleMock.mockReturnValue(
      btw.makeAsyncEvents([
        { type: "text_delta", delta: text },
        { type: "text_end", content: text, contentIndex: 0 },
        done,
      ]),
    );
    const runId = "btw-usage-reply-direct-block";
    const authorityRunId = "btw-usage-authority-direct-block";
    const sessionEntry = btw.createSessionEntry({ inputTokens: 200, cacheRead: 100 });
    const originalEntry = structuredClone(sessionEntry);
    const diagnostics: unknown[] = [];
    const unsubscribe = onInternalDiagnosticEvent((event) => {
      if (event.type === "model.usage") {
        diagnostics.push(event);
      }
    });
    try {
      await expect(
        btw.runSideQuestion({
          cfg: { diagnostics: { enabled: undefined } },
          sessionEntry,
          authorityRunId,
          blockReplyChunking: { minChars: 1, maxChars: 200, breakPreference: "paragraph" },
          resolvedBlockStreamingBreak: "text_end",
          opts: { runId, onBlockReply },
        }),
      ).resolves.toEqual(undefined);
      expect(onBlockReply).toHaveBeenCalledExactlyOnceWith({
        text,
        btw: { question: btw.DEFAULT_QUESTION },
      });
      expect
        .soft(consumeReplyUsageState(runId))
        .toMatchObject({ usage, sessionId: "session-1", turnUsd: 0.25 });
      expect(consumeReplyUsageState(authorityRunId)).toBeUndefined();
      expect(sessionEntry).toEqual(originalEntry);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect.soft(diagnostics).toEqual([
        expect.objectContaining({
          type: "model.usage",
          sessionId: "session-1",
          usage: { ...usage, promptTokens: 23 },
          costUsd: 0.25,
        }),
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("keeps an unprofiled subscription token on the OpenClaw BTW path", async () => {
    const supports = vi.fn(btw.supportsPreparedOpenAIAuth);
    const codexSideQuestionMock = btw.registerCodexSideQuestionHarness({ supports });
    const subscriptionModel = btw.createOpenAIModel(true);
    btw.mockResolvedModel(subscriptionModel);
    btw.resolveSessionAuthSelectionMock.mockResolvedValue(undefined);
    btw.ensureAuthProfileStoreMock.mockReturnValue({ version: 1, profiles: {} });
    btw.resolveProviderEntryApiKeyProfileReferenceMock.mockReturnValue({ kind: "literal" });
    btw.getApiKeyForModelMock.mockResolvedValue({
      apiKey: "subscription-token",
      mode: "token",
      source: "models.json",
    });
    btw.requireApiKeyMock.mockReturnValue("subscription-token");
    btw.mockDoneAnswer("OpenClaw side answer.");

    await expect(
      btw.runSideQuestion({
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
    expect(btw.streamSimpleMock).toHaveBeenCalled();
    btw.expectPreparedAuthSupport(supports, {
      source: "direct",
      mode: "token",
      requirement: "subscription",
    });
  });

  it("lets native Codex bootstrap auth without a host profile", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const supports = vi.fn((ctx: Parameters<AgentHarness["supports"]>[0]) => {
      if (ctx.modelProvider?.preparedAuth?.source !== "harness") {
        return btw.supportsPreparedOpenAIAuth(ctx);
      }
      return ctx.modelProvider.requestTransportOverrides === "none" &&
        ctx.modelProvider.runtimePolicy?.compatibleIds.includes("codex")
        ? { supported: true as const, priority: 100 }
        : { supported: false as const, reason: "deferred route support is missing" };
    });
    const codexSideQuestionMock = btw.registerCodexSideQuestionHarness({
      authBootstrap: "harness",
      supports,
    });
    const platformModel = btw.createOpenAIModel();
    btw.resolveModelWithRegistryMock.mockReturnValue(platformModel);
    btw.resolveSessionAuthSelectionMock.mockResolvedValue(undefined);
    btw.ensureAuthProfileStoreMock.mockReturnValue({ version: 1, profiles: {} });
    btw.getApiKeyForModelMock.mockResolvedValue({
      apiKey: undefined,
      mode: "api-key",
      source: "none",
    });

    await expect(btw.runSideQuestion({ provider: "openai", model: "gpt-5.5" })).resolves.toEqual({
      text: "Codex side answer.",
    });

    expect(codexSideQuestionMock).toHaveBeenCalledOnce();
    const { preparedRuntimeAuth } = btw.harnessParams(codexSideQuestionMock);
    expect(preparedRuntimeAuth?.plan).toMatchObject({
      harnessAuthProvider: "openai",
    });
    expect(preparedRuntimeAuth?.plan?.forwardedAuthProfileId).toBeUndefined();
    expect(preparedRuntimeAuth?.resolvedApiKey).toBeUndefined();
    expect(Object.keys(preparedRuntimeAuth?.authProfileStore?.profiles ?? {})).toEqual([]);
    btw.expectPreparedAuthSupport(supports, { source: "harness" });
  });

  it("hands a Codex side question the resolved Platform backup after subscription failure", async () => {
    const supports = vi.fn(btw.supportsPreparedOpenAIAuth);
    const codexSideQuestionMock = btw.registerCodexSideQuestionHarness({
      supports,
    });
    const subscriptionModel = btw.createOpenAIModel(true);
    const platformModel = btw.createOpenAIModel();
    btw.ensureAuthProfileStoreMock.mockReturnValue({
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
    btw.resolveSessionAuthSelectionMock.mockResolvedValue(undefined);
    btw.resolveModelWithRegistryMock.mockReturnValue(platformModel);
    btw.resolveModelAsyncMock.mockImplementation(
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
    btw.getApiKeyForModelMock.mockImplementation(async (authParams: { profileId?: string }) => {
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
      btw.runSideQuestion({
        cfg: {
          auth: {
            order: { openai: ["openai:subscription", "openai:platform"] },
          },
          ...btw.createRuntimeConfig("openai/gpt-5.5", "codex"),
        } as never,
        provider: "openai",
        model: "gpt-5.5",
        sessionKey: btw.DEFAULT_SESSION_KEY,
      }),
    ).resolves.toEqual({ text: "Codex side answer." });

    const sideQuestionParams = btw.harnessParams(codexSideQuestionMock);
    expect(sideQuestionParams.runtimeModel).toMatchObject(platformModel);
    expect(sideQuestionParams.authProfileId).toBeUndefined();
    expect(sideQuestionParams.preparedRuntimeAuth).toMatchObject({
      resolvedApiKey: "platform-key",
      plan: { modelRoute: { authRequirement: "api-key" } },
    });
    expect(
      Object.keys(sideQuestionParams.preparedRuntimeAuth?.authProfileStore?.profiles ?? {}),
    ).toEqual([]);
    expect(btw.streamSimpleMock).not.toHaveBeenCalled();
    btw.expectPreparedAuthSupport(supports, {
      source: "profile",
      mode: "api-key",
      requirement: "api-key",
    });
  });

  it("uses registry ownership and closes host capabilities when a BTW hook rejects", async () => {
    btw.registerAgentHarness(
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

    await expect(btw.runSideQuestion()).rejects.toThrow("side question failed");

    expect(btw.createAgentHarnessHostCapabilitiesMock).toHaveBeenCalledWith(
      expect.objectContaining({ pluginId: "actual-owner" }),
    );
    expect(btw.closeAgentHarnessHostCapabilitiesMock).toHaveBeenCalledOnce();
  });

  it("reselects the Codex hook after resolving legacy openai-codex route state", async () => {
    const codexSideQuestionMock = btw.registerCodexSideQuestionHarness({
      supports: (ctx) =>
        ctx.provider === "openai"
          ? { supported: true, priority: 100 }
          : { supported: false, reason: "openai only" },
    });
    btw.resolveModelWithRegistryMock.mockReturnValue(btw.createOpenAIModel());
    btw.resolveSessionAuthSelectionMock.mockResolvedValue({
      profileId: "openai-codex:user@example.test",
      source: "auto",
      routeRequirement: "subscription",
    });
    btw.ensureAuthProfileStoreMock.mockReturnValue({
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
    btw.resolveModelAsyncMock.mockResolvedValue({ model: btw.createOpenAIModel(true) });
    btw.getApiKeyForModelMock.mockResolvedValue({
      apiKey: "subscription-token",
      mode: "oauth",
      source: "profile:openai-codex:user@example.test",
      profileId: "openai-codex:user@example.test",
    });

    const result = await btw.runSideQuestion({
      cfg: {
        auth: {
          order: {
            openai: ["openai-codex:user@example.test"],
          },
        },
        ...btw.createRuntimeConfig("openai/gpt-5.5", "codex"),
      } as never,
      provider: "openai-codex",
      model: "gpt-5.5",
      sessionKey: btw.DEFAULT_SESSION_KEY,
    });

    expect(result).toEqual({ text: "Codex side answer." });
    expect(codexSideQuestionMock).toHaveBeenCalledTimes(1);
    const sideQuestionParams = btw.harnessParams(codexSideQuestionMock);
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
    expect(btw.streamSimpleMock).not.toHaveBeenCalled();
    expect(btw.registerProviderStreamForModelMock).not.toHaveBeenCalled();
  });

  it("does not fall back to the direct provider call when Codex lacks BTW support", async () => {
    btw.registerAgentHarness({
      id: "codex",
      label: "Codex test harness",
      supports: () => ({ supported: true, priority: 100 }),
      runAttempt: vi.fn(),
    });

    await expect(
      btw.runSideQuestion({
        provider: "openai",
        model: "gpt-5.5",
        sessionKey: btw.DEFAULT_SESSION_KEY,
      }),
    ).rejects.toThrow('Selected agent harness "codex" does not support /btw side questions.');
    expect(btw.streamSimpleMock).not.toHaveBeenCalled();
    expect(btw.registerProviderStreamForModelMock).not.toHaveBeenCalled();
  });

  it("rejects CLI session forks before backend preparation or provider I/O", async () => {
    btw.mockCliOutput({ text: "CLI side answer." });
    const params = {
      cfg: btw.createCliRuntimeConfig(),
      model: "claude-opus-4-7",
    };

    await expect(btw.runSideQuestion({ ...params, toolCalls: "deny" })).rejects.toThrow(
      "Session forks are not supported for CLI runtime claude-cli",
    );
    expect(btw.prepareCliRunContextMock).not.toHaveBeenCalled();
    expect(executePreparedCliRunMock).not.toHaveBeenCalled();
    expect(btw.streamSimpleMock).not.toHaveBeenCalled();
    expect(btw.registerProviderStreamForModelMock).not.toHaveBeenCalled();

    await expect(btw.runSideQuestion(params)).resolves.toEqual({ text: "CLI side answer." });
    expect(executePreparedCliRunMock).toHaveBeenCalledOnce();
  });

  it("answers ordinary CLI BTW without a side-question tool mode when the backend has no native tools", async () => {
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [
        {
          id: "claude-cli",
          pluginId: "no-tools-cli",
          modelProvider: "anthropic",
          config: { command: "no-tools-cli" },
          nativeToolMode: "none",
          ownsNativeCompaction: false,
        },
      ],
    });
    try {
      const { cleanup } = btw.mockCliOutput({ text: "No-tools CLI side answer." });

      await expect(
        btw.runSideQuestion({
          cfg: btw.createCliRuntimeConfig(),
          model: "claude-opus-4-7",
        }),
      ).resolves.toEqual({ text: "No-tools CLI side answer." });

      expect(btw.prepareCliRunContextMock).toHaveBeenCalledWith(
        expect.objectContaining({ executionMode: "side-question", disableTools: true }),
      );
      expect(cleanup).toHaveBeenCalledOnce();
      expect(btw.streamSimpleMock).not.toHaveBeenCalled();
    } finally {
      cliBackendsTesting.resetDepsForTest();
    }
  });

  it.each([
    { options: { timeoutOverrideSeconds: 0 }, expected: MAX_TIMER_TIMEOUT_MS },
    { options: { timeoutOverrideMs: 0 }, expected: MAX_TIMER_TIMEOUT_MS },
    { options: { timeoutOverrideSeconds: 1800, timeoutOverrideMs: 1500 }, expected: 1500 },
  ])(
    "preserves the timeout override $options for CLI-runtime BTW",
    async ({ options, expected }) => {
      btw.mockCliOutput({ text: "CLI side answer." });

      await btw.runSideQuestion({
        cfg: btw.createCliRuntimeConfig(),
        model: "claude-opus-4-7",
        opts: options,
        sessionKey: btw.DEFAULT_SESSION_KEY,
      });

      const prepareParams = btw.mockArg(btw.prepareCliRunContextMock, 0, 0) as {
        timeoutMs?: unknown;
        runTimeoutOverrideMs?: unknown;
      };
      expect(prepareParams.timeoutMs).toBe(expected);
      expect(prepareParams.runTimeoutOverrideMs).toBe(expected);
    },
  );

  it("does not expose raw CLI BTW output when transformed text is empty", async () => {
    const { cleanup } = btw.mockCliOutput({
      text: "   ",
      rawText: "raw untransformed answer",
    });

    await expect(
      btw.runSideQuestion({
        cfg: btw.createCliRuntimeConfig(),
        model: "claude-opus-4-7",
        sessionKey: btw.DEFAULT_SESSION_KEY,
      }),
    ).rejects.toThrow("/btw side question via claude-cli produced no answer");

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(btw.streamSimpleMock).not.toHaveBeenCalled();
  });

  it("preserves auto-selected session CLI BTW routing before resolving runtime auth", async () => {
    const { cleanup } = btw.mockCliOutput({ text: "Session Claude CLI answer." });
    const sessionEntry = btw.createSessionEntry({
      authProfileOverride: "anthropic:auto-cli",
      authProfileOverrideSource: "auto",
    });
    const sessionStore = { [btw.DEFAULT_SESSION_KEY]: sessionEntry };
    btw.resolveSessionAuthSelectionMock.mockImplementation(
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
    btw.mockDoneAnswer("Generic fallback answer.");

    const result = await btw.runSideQuestion({
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
      sessionKey: btw.DEFAULT_SESSION_KEY,
    });

    expect(result).toEqual({ text: "Session Claude CLI answer." });
    const prepareParams = btw.mockArg(btw.prepareCliRunContextMock, 0, 0) as {
      provider?: string;
      authProfileId?: string;
      executionMode?: string;
    };
    expect(prepareParams.provider).toBe("claude-cli");
    expect(prepareParams.executionMode).toBe("side-question");
    expect(prepareParams.authProfileId).toBe("anthropic:auto-cli");
    expect(btw.resolveSessionAuthSelectionMock).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(btw.getApiKeyForModelMock).not.toHaveBeenCalled();
    expect(btw.streamSimpleMock).not.toHaveBeenCalled();
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
    btw.ensureAuthProfileStoreWithoutExternalProfilesMock.mockReturnValueOnce(staticAuthStore);
    btw.ensureAuthProfileStoreMock.mockReturnValueOnce(claudeAuthStore);
    btw.getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: "claude-cli-access",
      mode: "oauth",
      source: "profile:anthropic:claude-cli",
      profileId: "anthropic:claude-cli",
    });
    btw.requireApiKeyMock.mockReturnValueOnce("claude-cli-access");
    btw.resolveSessionAuthSelectionMock.mockResolvedValueOnce(undefined);
    btw.resolveModelAsyncMock.mockResolvedValueOnce({
      model: {
        provider: btw.DEFAULT_PROVIDER,
        id: btw.DEFAULT_MODEL,
        api: "anthropic-messages",
      },
    });
    btw.mockDoneAnswer("Claude CLI answer.");

    const result = await btw.runSideQuestion();

    expect(result).toEqual({ text: "Claude CLI answer." });
    expect(btw.ensureAuthProfileStoreWithoutExternalProfilesMock).toHaveBeenCalledWith(
      btw.DEFAULT_AGENT_DIR,
      { allowKeychainPrompt: false },
    );
    expect(btw.ensureAuthProfileStoreMock).toHaveBeenCalledWith(btw.DEFAULT_AGENT_DIR, {
      externalCliProviderIds: ["claude-cli"],
      allowKeychainPrompt: false,
    });
    expect(btw.getApiKeyForModelMock).toHaveBeenCalledWith(
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
      id: btw.DEFAULT_MODEL,
      api: "anthropic-messages" as const,
      baseUrl: "https://backup.example.test",
      name: "Backup profile model",
    };
    btw.discoverAuthStorageMock.mockReturnValue(authStorage);
    btw.discoverModelsMock.mockReturnValue(modelRegistry);
    btw.resolveModelWithRegistryMock.mockReturnValue({
      provider: "anthropic",
      id: btw.DEFAULT_MODEL,
      api: "anthropic-messages",
      baseUrl: "https://primary.example.test",
      name: "Primary profile model",
    });
    btw.resolveModelAsyncMock.mockResolvedValue({
      model: rotatedModel,
      authStorage,
      modelRegistry,
    });
    btw.ensureAuthProfileStoreWithoutExternalProfilesMock.mockReturnValue(authStore);
    btw.resolveSessionAuthSelectionMock.mockResolvedValue(undefined);
    btw.getApiKeyForModelMock.mockImplementation(
      async (authParams: { profileId?: string } = {}) => {
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
      },
    );
    btw.requireApiKeyMock.mockReturnValue("backup-secret");
    btw.mockDoneAnswer("Backup answer.");

    await expect(
      btw.runSideQuestion({
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
      btw.getApiKeyForModelMock.mock.calls.map(
        ([authParams]) => (authParams as { profileId?: string }).profileId,
      ),
    ).toEqual(["anthropic:primary", "anthropic:backup"]);
    expect(btw.resolveModelAsyncMock).toHaveBeenCalledWith(
      "anthropic",
      btw.DEFAULT_MODEL,
      btw.DEFAULT_AGENT_DIR,
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
    const preparedAuthContext = btw.expectRecordFields(
      (btw.mockArg(btw.prepareProviderRuntimeAuthMock, 0, 0) as { context?: unknown }).context,
      {
        provider: "anthropic",
        modelId: btw.DEFAULT_MODEL,
        model: rotatedModel,
        profileId: "anthropic:backup",
      },
    );
    expect(preparedAuthContext.apiKey).toBe("backup-secret");
    btw.expectRecordFields(btw.mockArg(btw.streamSimpleMock, 0, 0), {
      name: "Backup profile model",
      baseUrl: "https://backup.example.test",
    });
  });

  it("uses a same-route literal fallback only after its prepared profile tier fails", async () => {
    const platformModel = { ...btw.createOpenAIModel(), name: "Platform model" };
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
    btw.mockResolvedModel(platformModel);
    btw.ensureAuthProfileStoreMock.mockReturnValue(authStore);
    btw.resolveSessionAuthSelectionMock.mockResolvedValue(undefined);
    btw.resolveProviderEntryApiKeyProfileReferenceMock.mockReturnValue({ kind: "literal" });
    btw.getApiKeyForModelMock.mockImplementation(
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
    btw.requireApiKeyMock.mockReturnValue("literal-key");
    btw.mockDoneAnswer("Literal fallback answer.");

    await expect(
      btw.runSideQuestion({
        cfg: {
          auth: { order: { openai: ["openai:broken"] } },
          models: {
            providers: {
              openai: { apiKey: "literal-key" },
            },
          },
          ...btw.createRuntimeConfig("openai/gpt-5.5", "openclaw"),
        } as never,
        provider: "openai",
        model: "gpt-5.5",
      }),
    ).resolves.toEqual({ text: "Literal fallback answer." });

    expect(
      btw.getApiKeyForModelMock.mock.calls.map(([authParams]) => {
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
    btw.expectRecordFields(btw.mockArg(btw.streamSimpleMock, 0, 0), {
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });
  });

  it.each([{ label: "legacy source-less", source: undefined }])(
    "keeps $label user-pinned static Anthropic auth first for BTW",
    async ({ source }) => {
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
      btw.ensureAuthProfileStoreMock.mockReturnValueOnce(staticAuthStore);
      btw.getApiKeyForModelMock.mockResolvedValueOnce({
        apiKey: "static-key",
        mode: "api-key",
        source: "profile:anthropic:api",
        profileId: "anthropic:api",
      });
      btw.requireApiKeyMock.mockReturnValueOnce("static-key");
      btw.resolveSessionAuthSelectionMock.mockResolvedValueOnce({
        profileId: "anthropic:api",
        source: "user",
        routeRequirement: "api-key",
      });
      btw.mockDoneAnswer("Static answer.");

      await btw.runSideQuestion({
        cfg: {
          auth: {
            order: { anthropic: ["anthropic:claude-cli"] },
            profiles: {
              "anthropic:api": { provider: "anthropic", mode: "api_key" },
              "anthropic:claude-cli": { provider: "claude-cli", mode: "oauth" },
            },
          },
        } as never,
        sessionEntry: btw.createSessionEntry({
          authProfileOverride: "anthropic:api",
          authProfileOverrideSource: source,
        }),
      });

      expect(btw.ensureAuthProfileStoreWithoutExternalProfilesMock).not.toHaveBeenCalled();
      expect(btw.ensureAuthProfileStoreMock).toHaveBeenCalledWith(btw.DEFAULT_AGENT_DIR, {
        profileId: "anthropic:api",
        externalCliProviderIds: ["claude-cli"],
        allowKeychainPrompt: false,
      });
      btw.expectRecordFields(btw.mockArg(btw.getApiKeyForModelMock, 0, 0), {
        profileId: "anthropic:api",
        store: staticAuthStore,
      });
      btw.expectRecordFields(
        (btw.mockArg(btw.prepareProviderRuntimeAuthMock, 0, 0) as { context?: unknown }).context,
        {
          profileId: "anthropic:api",
          authMode: "api-key",
        },
      );
    },
  );

  it("applies provider runtime auth before streaming github-copilot BTW questions", async () => {
    btw.mockResolvedModel({
      provider: "github-copilot",
      id: "gpt-5.4",
      api: "openai-responses",
      baseUrl: "https://api.individual.githubcopilot.com",
    });
    btw.getApiKeyForModelMock.mockResolvedValue({
      apiKey: "github-token",
      mode: "token",
      source: "profile",
      profileId: "github-copilot:github",
    });
    btw.requireApiKeyMock.mockReturnValue("github-token");
    btw.prepareProviderRuntimeAuthMock.mockResolvedValue({
      apiKey: "copilot-runtime-token",
      baseUrl: "https://api.enterprise.githubcopilot.com",
    });
    btw.mockDoneAnswer("Copilot answer.");

    const result = await btw.runSideQuestion({
      provider: "github-copilot",
      model: "gpt-5.4",
    });

    expect(result).toEqual({ text: "Copilot answer." });
    const runtimeAuthParams = btw.expectRecordFields(
      btw.mockArg(btw.prepareProviderRuntimeAuthMock, 0, 0),
      {
        provider: "github-copilot",
        workspaceDir: "/tmp/workspace",
      },
    );
    btw.expectRecordFields(runtimeAuthParams.context, {
      provider: "github-copilot",
      modelId: "gpt-5.4",
      workspaceDir: "/tmp/workspace",
      apiKey: "github-token",
      authMode: "token",
      profileId: "github-copilot:github",
    });
    const [streamModel, , streamOptions] = btw.mockCall(btw.streamSimpleMock);
    btw.expectRecordFields(streamModel, {
      provider: "github-copilot",
      id: "gpt-5.4",
      baseUrl: "https://api.enterprise.githubcopilot.com",
    });
    const streamKey = (streamOptions as { apiKey?: string }).apiKey ?? "";
    expect(looksLikeSecretSentinel(streamKey)).toBe(true);
    expect(streamKey).not.toBe("copilot-runtime-token");
    expect(resolveSecretSentinel(streamKey)).toBe("copilot-runtime-token");
  });

  it("strips injected empty tools arrays from BTW payloads before sending", async () => {
    btw.mockDoneAnswer("Final answer.");

    await btw.runSideQuestion();

    const options = btw.mockArg(btw.streamSimpleMock, 0, 2);
    const onPayload = (options as { onPayload?: (payload: unknown) => void })?.onPayload;
    const payloadWithEmptyTools = { messages: [], tools: [] as unknown[] };

    const result = onPayload?.(payloadWithEmptyTools);

    expect(payloadWithEmptyTools).not.toHaveProperty("tools");
    expect(result).toBeUndefined();
  });

  it("allows Bedrock /btw runs to proceed without a static api key in aws-sdk mode", async () => {
    btw.resolveModelWithRegistryMock.mockReturnValue({
      provider: "amazon-bedrock",
      id: "us.anthropic.claude-sonnet-4-5-v1:0",
      api: "anthropic-messages",
    });
    btw.getApiKeyForModelMock.mockResolvedValue({
      apiKey: undefined,
      mode: "aws-sdk",
      source: "aws-sdk default chain",
    });
    btw.streamSimpleMock.mockReturnValue(
      btw.makeAsyncEvents([btw.createDoneEvent("Bedrock answer.")]),
    );

    const result = await btw.runSideQuestion({
      cfg: {},
      provider: "amazon-bedrock",
      model: "us.anthropic.claude-sonnet-4-5-v1:0",
    });

    expect(result).toEqual({ text: "Bedrock answer." });
    expect(btw.requireApiKeyMock).not.toHaveBeenCalled();
    const options = btw.streamSimpleMock.mock.calls.at(-1)?.[2];
    expect((options as { apiKey?: string } | undefined)?.apiKey).toBeUndefined();
  });

  it("uses the in-flight prompt as background only when there is no prior transcript context", async () => {
    btw.clearBuiltSessionMessages();
    btw.getActiveEmbeddedRunSnapshotMock.mockReturnValue({
      transcriptLeafId: null,
      messages: [],
      inFlightPrompt: "build me a tic-tac-toe game in brainfuck",
    });
    btw.mockDoneAnswer("You're building a tic-tac-toe game in Brainfuck.");

    const result = await btw.runSideQuestion({ question: "what are we doing?" });

    expect(result).toEqual({ text: "You're building a tic-tac-toe game in Brainfuck." });
    const [message] = btw.contextMessages(btw.streamContext());
    btw.expectRecordFields(message, { role: "user" });
    btw.expectTextBlockContains(
      expectDefined(
        (expectDefined(message, "message test invariant").content as Array<unknown>)[0],
        "(message.content as Array<unknown>)[0] test invariant",
      ),
      "<in_flight_main_task>\nbuild me a tic-tac-toe game in brainfuck\n</in_flight_main_task>",
    );
  });

  it("branches away from an unresolved trailing user turn before building BTW context", async () => {
    const assistantEntry = btw.createTranscriptEntry({
      id: "assistant-1",
      message: btw.createAssistantTranscriptMessage([{ type: "text", text: "seed answer" }]),
    });
    const trailingUserEntry = btw.createTranscriptEntry({
      id: "user-2",
      parentId: "assistant-1",
      message: btw.createUserTranscriptMessage([{ type: "text", text: "unfinished task" }]),
    });
    btw.mockTranscriptEntries([assistantEntry, trailingUserEntry]);
    btw.mockDoneAnswer(btw.MATH_ANSWER);

    const result = await btw.runMathSideQuestion();

    expect(btw.buildSessionContextMock).toHaveBeenCalledTimes(1);
    expect(btw.buildSessionContextMock).toHaveBeenCalledWith([assistantEntry]);
    expect(result).toEqual({ text: btw.MATH_ANSWER });
  });

  it("rejects a supplied session key that disagrees with an incomplete SQLite marker target", async () => {
    const markerStorePath = "/tmp/marker-sessions.sqlite";
    btw.listSessionEntriesCoreMock.mockReturnValue([
      {
        sessionKey: "agent:main:matching",
        entry: btw.createSessionEntry(),
      },
    ]);
    btw.loadSessionEntryMock.mockReturnValue(
      btw.createSessionEntry({ sessionId: "different-session" }),
    );

    await expect(
      btw.runMathSideQuestion({
        sessionEntry: btw.createSessionEntry({
          sessionFile: `sqlite:main:session-1:${markerStorePath}`,
        }),
        storePath: undefined,
      }),
    ).rejects.toThrow("No active session context.");

    expect(btw.listSessionEntriesCoreMock).toHaveBeenCalledWith({
      agentId: "main",
      storePath: markerStorePath,
    });
    expect(btw.loadSessionEntryMock).toHaveBeenCalledWith({
      agentId: "main",
      sessionKey: btw.DEFAULT_SESSION_KEY,
      storePath: markerStorePath,
    });
    expect(btw.loadTranscriptEventsMock).not.toHaveBeenCalled();
  });

  it("falls back when the active run snapshot leaf no longer exists", async () => {
    const { userEntry, assistantEntry } = createSeedTranscript();
    btw.mockTranscriptEntries([userEntry, assistantEntry]);
    btw.getActiveEmbeddedRunSnapshotMock.mockReturnValue({
      transcriptLeafId: "assistant-gone",
    });
    btw.mockDoneAnswer(btw.MATH_ANSWER);

    const result = await btw.runMathSideQuestion();

    expect(btw.buildSessionContextMock).toHaveBeenCalledTimes(1);
    expect(btw.buildSessionContextMock).toHaveBeenCalledWith([userEntry, assistantEntry]);
    expect(result).toEqual({ text: btw.MATH_ANSWER });
    expect(btw.diagDebugMock).toHaveBeenCalledWith(
      "btw snapshot leaf unavailable: sessionId=session-1 leaf=assistant-gone",
    );
  });

  it("keeps visible history after continuing from a disjoint opaque append cursor", async () => {
    const { userEntry, assistantEntry } = createSeedTranscript();
    const sideEntry = btw.createTranscriptEntry({
      id: "side-delivery",
      parentId: "assistant-seed",
      message: btw.createAssistantTranscriptMessage([{ type: "text", text: "side delivery" }]),
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
    const continuationEntry = btw.createTranscriptEntry({
      id: "assistant-continuation",
      parentId: "plugin-metadata",
      message: btw.createAssistantTranscriptMessage([{ type: "text", text: "continued answer" }]),
    });
    btw.mockTranscriptEntries([
      userEntry,
      assistantEntry,
      sideEntry,
      metadataEntry,
      leafEntry,
      continuationEntry,
    ]);
    btw.mockDoneAnswer(btw.MATH_ANSWER);

    const result = await btw.runMathSideQuestion();

    expect(btw.buildSessionContextMock).toHaveBeenCalledWith([
      userEntry,
      assistantEntry,
      { ...continuationEntry, parentId: "assistant-seed" },
    ]);
    expect(result).toEqual({ text: btw.MATH_ANSWER });
  });

  it("excludes tool results from BTW context to avoid replaying raw tool output", async () => {
    btw.mockActiveTranscript([
      btw.createUserTranscriptMessage(),
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
    btw.mockDoneAnswer(btw.MATH_ANSWER);

    await btw.runMathSideQuestion();

    const messages = btw.contextMessages(btw.streamContext());
    expect(messages).toHaveLength(3);
    btw.expectRecordFields(messages[0], { role: "user" });
    btw.expectRecordFields(messages[1], { role: "assistant" });
    btw.expectRecordFields(messages[2], { role: "user" });
    expect(messages.some((message) => message.role === "toolResult")).toBe(false);
  });

  it("strips assistant tool calls from fallback BTW context so stale calls are not replayed", async () => {
    btw.mockActiveTranscript([
      btw.createUserTranscriptMessage(),
      btw.createAssistantTranscriptMessage(
        [
          { type: "text", text: "Let me check." },
          { type: "thinking", thinking: "Hidden chain of thought" },
          { type: "toolCall", id: "call_1", name: "read", arguments: { path: "README.md" } },
          { type: "toolUse", id: "call_legacy", name: "read", input: { path: "README.md" } },
          { type: "tool_call", id: "call_snake", name: "read", arguments: { path: "README.md" } },
        ],
        { stopReason: "toolUse" },
      ),
    ]);
    btw.mockDoneAnswer(btw.MATH_ANSWER);

    await btw.runMathSideQuestion();

    const context = btw.streamContext();
    btw.expectSanitizedAssistantContext(context, "Let me check.");
  });

  it("strips embedded user tool results from BTW context", async () => {
    btw.mockActiveTranscript([
      btw.createUserTranscriptMessage([
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

    const context = await btw.runMathSideQuestionAndCaptureContext();
    btw.expectSeedOnlyUserContext(context);
  });

  it("drops malformed user image blocks from BTW context", async () => {
    btw.mockActiveTranscript([
      btw.createUserTranscriptMessage([
        { type: "text", text: "seed" },
        { type: "image", mimeType: "image/png" },
      ]),
    ]);

    const context = await btw.runMathSideQuestionAndCaptureContext();
    btw.expectSeedOnlyUserContext(context);
  });

  it("normalizes malformed assistant content before stripping tool blocks", async () => {
    btw.mockActiveTranscript([
      btw.createUserTranscriptMessage(),
      btw.createAssistantTranscriptMessage(
        { type: "toolCall", id: "call_1", name: "read", arguments: {} },
        { stopReason: "toolUse", output: 0 },
      ),
    ]);

    const context = await btw.runMathSideQuestionAndCaptureContext();

    btw.expectNoAssistantMessages(context);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
