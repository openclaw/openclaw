// Exercises settled-turn finalization for a run whose transcript custody is a
// host-owned session manager (skill Workshop review shape): the isolated
// tool-free finalizer must keep the borrowed manager custody through the real
// run loop, built-in harness selection, provider stream, tool execution, and
// session transcript writer path; only provider transport is deterministic.
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import {
  createEmbeddedAgentRunnerOpenAiConfig,
  createResolvedEmbeddedRunnerModel,
} from "./test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { installEmbeddedRunnerBaseE2eMocks } from "./test-helpers/embedded-agent-runner-e2e-mocks.js";

const finalAnswer = "The review completed.";
const toolFile = "review-note.txt";

type RuntimeModel = { api: string; provider: string; id: string };
type StreamContext = {
  messages?: Array<{ role?: string; content?: unknown }>;
  tools?: Array<{ name?: string }>;
};

const llmHarness = vi.hoisted(() => {
  const usage = {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const calls: Array<{
    call: number;
    toolNames: string[];
    hasToolResult: boolean;
    lastRole?: string;
    promptText?: string;
  }> = [];
  const advanceStoreWriterGeneration = vi.fn(async () => undefined);
  const beforeFinalAnswer = vi.fn(async () => undefined);
  const textOf = (content: unknown): string | undefined => {
    if (typeof content === "string") {
      return content;
    }
    if (!Array.isArray(content)) {
      return undefined;
    }
    return content
      .map((item) => {
        if (!item || typeof item !== "object" || !("text" in item)) {
          return "";
        }
        const value = (item as { text?: unknown }).text;
        if (typeof value === "string") {
          return value;
        }
        return typeof value === "number" || typeof value === "boolean" ? `${value}` : "";
      })
      .join("")
      .trim();
  };
  const buildAssistant = (model: RuntimeModel, overrides: Record<string, unknown>) => ({
    role: "assistant" as const,
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    stopReason: "stop" as const,
    timestamp: Date.now(),
    ...overrides,
  });
  const nextMessage = async (model: RuntimeModel, context: StreamContext = {}) => {
    const call = calls.length + 1;
    calls.push({
      call,
      toolNames: context.tools?.map((tool) => tool.name?.trim() ?? "").filter(Boolean) ?? [],
      hasToolResult: context.messages?.some((message) => message.role === "toolResult") ?? false,
      lastRole: context.messages?.at(-1)?.role,
      promptText: textOf(context.messages?.at(-1)?.content),
    });
    if (call === 1) {
      return buildAssistant(model, {
        stopReason: "toolUse",
        content: [
          {
            type: "toolCall",
            id: "read-once",
            name: "read",
            arguments: { path: toolFile },
          },
        ],
      });
    }
    if (call === 2) {
      await advanceStoreWriterGeneration();
      return buildAssistant(model, { content: [] });
    }
    if (call === 3) {
      await beforeFinalAnswer();
      return buildAssistant(model, {
        content: [{ type: "text", text: finalAnswer }],
      });
    }
    throw new Error(`unexpected model call ${call}`);
  };
  return { advanceStoreWriterGeneration, beforeFinalAnswer, calls, nextMessage };
});

vi.mock("@openclaw/ai/transports", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openclaw/ai/transports")>();
  const { createAssistantMessageEventStream } =
    await vi.importActual<typeof import("openclaw/plugin-sdk/llm")>("openclaw/plugin-sdk/llm");
  type AssistantMessage = import("openclaw/plugin-sdk/llm").AssistantMessage;
  const streamFromHarness = (model: RuntimeModel, context?: StreamContext) => {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      void (async () => {
        try {
          const message = (await llmHarness.nextMessage(model, context)) as AssistantMessage;
          const reason =
            message.stopReason === "length" || message.stopReason === "toolUse"
              ? message.stopReason
              : "stop";
          stream.push({ type: "done", reason, message });
          stream.end();
        } catch (error) {
          stream.push({
            type: "error",
            reason: "error",
            error: {
              role: "assistant",
              content: [],
              api: model.api,
              provider: model.provider,
              model: model.id,
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: "error",
              errorMessage: error instanceof Error ? error.message : String(error),
              timestamp: Date.now(),
            },
          });
        }
      })();
    });
    return stream;
  };
  const createHarnessStreamFn = () => (model: RuntimeModel, context?: StreamContext) =>
    streamFromHarness(model, context);
  return {
    ...actual,
    createBoundaryAwareStreamFnForModel: createHarnessStreamFn,
    createOpenClawTransportStreamFnForModel: createHarnessStreamFn,
    createOpenAIResponsesTransportStreamFn: createHarnessStreamFn,
  };
});

vi.mock("openclaw/plugin-sdk/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/llm")>();
  type AssistantMessage = import("openclaw/plugin-sdk/llm").AssistantMessage;
  const streamFromHarness = (model: RuntimeModel, context?: StreamContext) => {
    const stream = actual.createAssistantMessageEventStream();
    queueMicrotask(() => {
      void (async () => {
        try {
          const message = (await llmHarness.nextMessage(model, context)) as AssistantMessage;
          const reason =
            message.stopReason === "length" || message.stopReason === "toolUse"
              ? message.stopReason
              : "stop";
          stream.push({ type: "done", reason, message });
          stream.end();
        } catch (error) {
          stream.push({
            type: "error",
            reason: "error",
            error: {
              role: "assistant",
              content: [],
              api: model.api,
              provider: model.provider,
              model: model.id,
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: "error",
              errorMessage: error instanceof Error ? error.message : String(error),
              timestamp: Date.now(),
            },
          });
        }
      })();
    });
    return stream;
  };
  return {
    ...actual,
    complete: (model: RuntimeModel, context?: StreamContext) =>
      llmHarness.nextMessage(model, context),
    completeSimple: (model: RuntimeModel, context?: StreamContext) =>
      llmHarness.nextMessage(model, context),
    stream: (model: RuntimeModel, context?: StreamContext) => streamFromHarness(model, context),
    streamSimple: (model: RuntimeModel, context?: StreamContext) =>
      streamFromHarness(model, context),
  };
});

const finalizerProbe = vi.hoisted(() => ({
  calls: [] as Array<{ sessionId?: string; sessionTarget?: unknown }>,
}));

// Observe the real built-in attempt without replacing it. This makes the
// custody handoff itself part of the regression proof while preserving the
// production run loop, tool execution, transcript writes, and finalizer.
vi.mock("./embedded-agent-runner/run/attempt.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./embedded-agent-runner/run/attempt.js")>();
  return {
    ...actual,
    runEmbeddedAttempt: async (params: Parameters<typeof actual.runEmbeddedAttempt>[0]) => {
      if (params.operation === "settled-tool-finalization") {
        finalizerProbe.calls.push({
          sessionId: params.sessionId,
          sessionTarget: params.sessionTarget,
        });
      }
      return await actual.runEmbeddedAttempt(params);
    },
  };
});

const sessionDirs = useSessionStoreTempDirs(afterAll, "finalizer-writer-rebound-");
let runEmbeddedAgent: typeof import("./embedded-agent-runner/run.js").runEmbeddedAgent;
let prepareSystemAgentRunAdmission: typeof import("./admitted-run-context.js").prepareSystemAgentRunAdmission;
let SessionManager: typeof import("./sessions/session-manager.js").SessionManager;
let replaceSessionEntry: typeof import("../config/sessions/session-accessor.js").replaceSessionEntry;
let loadSessionEntryReadOnly: typeof import("../config/sessions/session-accessor.js").loadSessionEntryReadOnly;
let readMessages: typeof import("../plugin-sdk/session-transcript-runtime.js").readVisibleSessionTranscriptMessageEntries;

beforeAll(async () => {
  vi.useRealTimers();
  vi.resetModules();
  installEmbeddedRunnerBaseE2eMocks({ hookRunner: "full" });
  // mock-isolation: Keep context engine plugin discovery outside this full-runner fixture.
  vi.doMock("../context-engine/registry.js", () => ({
    hasSameContextEngineInstance: vi.fn((left: unknown, right: unknown) => left === right),
    resolveContextEngine: vi.fn(async () => ({ dispose: async () => undefined })),
    resolveContextEngineOwnerPluginId: vi.fn(() => undefined),
    resolveContextEngineTranscriptByteLimit: vi.fn(() => undefined),
    resolveLogicalTurnContextEngines: vi.fn(async () => {
      const engine = {
        info: { id: "legacy", name: "Legacy Context Engine" },
        async ingest() {
          return { ingested: false };
        },
        async assemble({ messages }: { messages: unknown[] }) {
          return { messages, estimatedTokens: 0 };
        },
        async compact() {
          return { ok: true, compacted: false };
        },
        async dispose() {},
      };
      const ref = { engine, registeredId: "legacy" };
      return { configured: ref, configuredId: "legacy", fallback: ref };
    }),
  }));
  // mock-isolation: Keep provider plugin hooks inert while provider transport stays deterministic.
  vi.doMock("../plugins/provider-hook-runtime.js", () => ({
    attachModelProviderRuntimePluginHandle: (model: unknown) => model,
    ensureProviderRuntimePluginHandle: vi.fn((params: object) => params),
    getModelProviderRuntimePluginHandle: vi.fn(() => undefined),
    prepareProviderExtraParams: vi.fn(() => undefined),
    resolveLoadedProviderPluginsForHooks: vi.fn(() => undefined),
    resolveLoadedProviderRuntimePlugin: vi.fn(() => undefined),
    resolveProviderAuthProfileId: vi.fn(() => undefined),
    resolveProviderExtraParamsForTransport: vi.fn(() => undefined),
    resolveProviderExtraParamsForHooks: vi.fn(() => undefined),
    resolveProviderFollowupFallbackRoute: vi.fn(() => undefined),
    resolveProviderHookPlugin: vi.fn(() => undefined),
    resolveProviderPluginsForHooks: vi.fn(() => []),
    resolveProviderRuntimePlugin: vi.fn(() => undefined),
    resolveProviderRuntimePluginHandle: vi.fn((params: object) => params),
    wrapProviderSimpleCompletionStreamFn: vi.fn(() => undefined),
    wrapProviderStreamFn: vi.fn(() => undefined),
  }));
  // mock-isolation: Prevent model config file writes from the isolated test workspace.
  vi.doMock("./models-config.js", () => ({
    ensureOpenClawModelsJson: vi.fn(async () => ({ wrote: false })),
  }));
  // mock-isolation: Supply a resolved in-memory model registry without loading live provider catalogs.
  vi.doMock("./embedded-agent-runner/model.js", () => ({
    resolveModelAsync: async (provider: string, modelId: string) => {
      const resolved = createResolvedEmbeddedRunnerModel(provider, modelId);
      const { initializeModelRegistryRuntime } =
        await import("./sessions/model-registry-runtime.js");
      const modelRegistry = resolved.modelRegistry as typeof resolved.modelRegistry & {
        find(provider: string, modelId: string): typeof resolved.model | undefined;
        getApiKeyAndHeaders(): Promise<{ ok: true; apiKey: string }>;
        hasConfiguredAuth(): boolean;
        isUsingOAuth(): boolean;
        refresh(): void;
        registerProvider(): void;
        unregisterProvider(): void;
      };
      Object.assign(modelRegistry, {
        find: (candidateProvider: string, candidateModelId: string) =>
          candidateProvider === provider && candidateModelId === modelId
            ? resolved.model
            : undefined,
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-api-key" }),
        hasConfiguredAuth: () => true,
        isUsingOAuth: () => false,
        refresh: () => undefined,
        registerProvider: () => undefined,
        unregisterProvider: () => undefined,
      });
      initializeModelRegistryRuntime(modelRegistry);
      return resolved;
    },
  }));
  // mock-isolation: Avoid starting MCP runtimes; this fixture exercises the built-in read tool.
  vi.doMock("./agent-bundle-mcp-tools.js", () => ({
    acquireSessionMcpRuntime: vi.fn(async () => undefined),
    disposeSessionMcpRuntime: vi.fn(async () => undefined),
    retireSessionMcpRuntimeForSessionKey: vi.fn(async () => false),
    retireSessionMcpRuntime: vi.fn(async () => false),
  }));
  // mock-isolation: Keep external auth profile discovery out of this provider-transport fixture.
  vi.doMock("../plugins/provider-external-auth.js", () => ({
    resolveExternalAuthProfilesWithPlugins: vi.fn(() => []),
  }));
  // mock-isolation: Bypass dynamic model materialization while preserving the prepared model object.
  vi.doMock("./runtime-plan/materialize-model.js", () => ({
    materializePreparedRuntimeModel: vi.fn(
      async <Model>(params: { model?: Model }): Promise<Model | undefined> => params.model,
    ),
  }));
  ({ runEmbeddedAgent } = await import("./embedded-agent-runner/run.js"));
  ({ prepareSystemAgentRunAdmission } = await import("./admitted-run-context.js"));
  ({ SessionManager } = await import("./sessions/session-manager.js"));
  ({ replaceSessionEntry, loadSessionEntryReadOnly } =
    await import("../config/sessions/session-accessor.js"));
  ({ readVisibleSessionTranscriptMessageEntries: readMessages } =
    await import("../plugin-sdk/session-transcript-runtime.js"));
});

beforeEach(() => {
  llmHarness.calls.length = 0;
  llmHarness.advanceStoreWriterGeneration.mockReset();
  llmHarness.beforeFinalAnswer.mockReset();
  finalizerProbe.calls.length = 0;
});

async function createBorrowedCustodyFixture(runId = "review-run") {
  const root = sessionDirs.make();
  const agentDir = path.join(root, "agents", "test", "agent");
  const workspaceDir = path.join(root, "workspace");
  await Promise.all([fs.mkdir(agentDir, { recursive: true }), fs.mkdir(workspaceDir)]);
  await fs.writeFile(path.join(workspaceDir, toolFile), "reviewed\n", "utf8");

  const config = createEmbeddedAgentRunnerOpenAiConfig(["mock-1"]);
  config.agents ??= {};
  config.agents.defaults ??= {};
  config.agents.defaults.sessionStore = { agentId: "test" };
  config.session = { store: path.join(agentDir, "openclaw-agent.sqlite") };

  const privateSessionId = "internal-session-effects-review-run-0123456789abcdef";
  const privateSessionKey = "agent:test:internal-session-effects:review-run-0123456789abcdef";
  const privateTarget = {
    agentId: "test",
    sessionId: privateSessionId,
    sessionKey: privateSessionKey,
    storePath: config.session.store,
  };
  await replaceSessionEntry(privateTarget, {
    sessionId: privateSessionId,
    updatedAt: 1,
    lifecycleRevision: "dispatch-generation",
    activeWriterRunId: "dispatch-writer",
  });

  const borrowedManager = SessionManager.inMemory(workspaceDir);
  expect(borrowedManager.getSessionId()).not.toBe(privateSessionId);

  const admission = prepareSystemAgentRunAdmission(
    config,
    runId,
    "test",
    "finalizer-writer-rebound-test",
  );

  const run = () =>
    runEmbeddedAgent({
      preparedRunAdmission: admission,
      agentId: "test",
      sessionId: privateSessionId,
      sessionKey: privateSessionKey,
      sessionManager: borrowedManager,
      sessionPersistence: "detached",
      workspaceDir,
      agentDir,
      config,
      prompt: "Review the completed session.",
      provider: "openai",
      model: "mock-1",
      agentHarnessRuntimeOverride: "openclaw",
      toolsAllow: ["read"],
      runId,
      timeoutMs: 10_000,
      enqueue: async (task) => await task(),
    });

  return {
    admission,
    borrowedManager,
    privateSessionId,
    privateTarget,
    run,
  };
}

describe("settled-turn finalization under host-owned transcript custody", () => {
  it("persists the real finalizer answer to the borrowed manager after the private writer generation advances", async () => {
    const fixture = await createBorrowedCustodyFixture();
    const { admission, borrowedManager, privateSessionId, privateTarget, run } = fixture;

    let advancedAfterDispatch = false;
    llmHarness.advanceStoreWriterGeneration.mockImplementation(async () => {
      expect(llmHarness.calls.map((call) => call.call)).toEqual([1, 2]);
      expect(llmHarness.calls[1]).toEqual(expect.objectContaining({ hasToolResult: true }));
      await replaceSessionEntry(privateTarget, {
        // Rebind the private store key to the successor generation. A finalizer
        // that incorrectly mints direct-store custody for the dispatched run
        // will now be refused by the real transcript writer guard.
        sessionId: "successor-session",
        updatedAt: 2,
        lifecycleRevision: "advanced-generation",
        activeWriterRunId: "advanced-writer",
      });
      advancedAfterDispatch = true;
    });

    try {
      const result = await run();

      expect(advancedAfterDispatch).toBe(true);
      expect(loadSessionEntryReadOnly(privateTarget)).toMatchObject({
        lifecycleRevision: "advanced-generation",
        activeWriterRunId: "advanced-writer",
      });
      expect(result?.payloads).toEqual([expect.objectContaining({ text: finalAnswer })]);
      expect(finalizerProbe.calls).toEqual([
        { sessionId: privateSessionId, sessionTarget: undefined },
      ]);
      expect(llmHarness.calls).toEqual([
        expect.objectContaining({ call: 1, toolNames: expect.arrayContaining(["read"]) }),
        expect.objectContaining({ call: 2, hasToolResult: true }),
        expect.objectContaining({ call: 3, toolNames: [] }),
      ]);

      const borrowedTranscript = borrowedManager.buildSessionContext().messages;
      expect(borrowedTranscript).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            content: [{ type: "text", text: "Review the completed session." }],
          }),
          expect.objectContaining({
            role: "assistant",
            content: expect.arrayContaining([
              expect.objectContaining({ type: "toolCall", id: "read-once", name: "read" }),
            ]),
          }),
          expect.objectContaining({ role: "toolResult", toolCallId: "read-once" }),
          expect.objectContaining({
            role: "assistant",
            content: [{ type: "text", text: finalAnswer }],
          }),
        ]),
      );
      const borrowedLastMessage = borrowedTranscript.at(-1);
      expect(borrowedLastMessage).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: finalAnswer }],
      });
      const privateTranscriptMessages = await readMessages(privateTarget);
      expect(privateTranscriptMessages).toEqual([]);
      if (process.env.FINALIZER_REBOUND_PROOF_LOG === "1") {
        console.info(
          `[finalizer-rebound-proof] ${JSON.stringify({
            finalizerCustody: finalizerProbe.calls,
            privateTranscriptMessageCount: privateTranscriptMessages.length,
            borrowedLastMessage,
            recoveredPayloads: result?.payloads,
          })}`,
        );
      }
    } finally {
      admission.close();
    }
  });

  it("rejects final effects when the real borrowed-manager run admission closes during finalization", async () => {
    const fixture = await createBorrowedCustodyFixture("revoked-review-run");
    const { admission, borrowedManager, privateSessionId, privateTarget, run } = fixture;

    let advancedAfterDispatch = false;
    llmHarness.advanceStoreWriterGeneration.mockImplementation(async () => {
      expect(llmHarness.calls.map((call) => call.call)).toEqual([1, 2]);
      await replaceSessionEntry(privateTarget, {
        sessionId: "successor-session",
        updatedAt: 2,
        lifecycleRevision: "advanced-generation",
        activeWriterRunId: "advanced-writer",
      });
      advancedAfterDispatch = true;
    });
    llmHarness.beforeFinalAnswer.mockImplementation(async () => {
      expect(llmHarness.calls.map((call) => call.call)).toEqual([1, 2, 3]);
      admission.close();
    });

    let result: Awaited<ReturnType<typeof runEmbeddedAgent>> | undefined;
    let thrown: unknown;
    try {
      result = await run();
    } catch (error) {
      thrown = error;
    } finally {
      admission.close();
    }

    expect(advancedAfterDispatch).toBe(true);
    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown instanceof Error ? thrown.message : thrown)).toContain(
      "admitted run authority is no longer active",
    );
    expect(result?.payloads ?? []).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ text: finalAnswer })]),
    );
    expect(finalizerProbe.calls).toEqual([
      { sessionId: privateSessionId, sessionTarget: undefined },
    ]);
    expect(llmHarness.calls).toEqual([
      expect.objectContaining({ call: 1, toolNames: expect.arrayContaining(["read"]) }),
      expect.objectContaining({ call: 2, hasToolResult: true }),
      expect.objectContaining({ call: 3, toolNames: [] }),
    ]);
    const borrowedTranscript = borrowedManager.buildSessionContext().messages;
    expect(borrowedTranscript).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: [{ type: "text", text: finalAnswer }],
        }),
      ]),
    );
    expect(await readMessages(privateTarget)).toEqual([]);
  });
});
