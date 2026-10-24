import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import type { ImageContent, Model, SimpleStreamOptions } from "../../llm/types.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../../logging/secret-redaction-registry.test-support.js";
import {
  attachRuntimePromptMediaFacts,
  readRuntimePromptMediaFacts,
} from "../../media/media-facts.js";
import { finalizeRuntimePromptImages } from "../../media/runtime-prompt-image-provenance.js";
import { toToolDefinitions } from "../agent-tool-definition-adapter.js";
import type { AgentTool, AgentMessage } from "../runtime/index.js";
import { attachInternalToolExecutionPreparer } from "../runtime/internal-hooks.js";
import { createZeroUsageFixture } from "../test-helpers/usage-fixtures.js";
import {
  createAssistant,
  createAssistantResultStream,
  testModel as loopTestModel,
} from "./agent-session-loop-correctness.test-support.js";
import {
  createCompactionExtension,
  createResourceLoader,
} from "./agent-session-loop-resource-loader.test-support.js";
import { AuthStorage } from "./auth-storage.js";
import type {
  ExtensionFactory,
  MessageEndEvent,
  ToolDefinition,
  ToolResultEvent,
} from "./extensions/types.js";
import { ModelRegistry } from "./model-registry.js";
import { createAgentSession } from "./sdk.js";
import { withSessionState } from "./session-manager-fixtures.test-support.js";
import { CURRENT_SESSION_VERSION, SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

const streamMocks = { streamSimple: vi.fn() };
const testModel: Model = { ...loopTestModel, contextWindow: 1000, maxTokens: 1000 };

function createModelWithoutBaseUrl(overrides: Partial<Model>): Model {
  const { baseUrl: _baseUrl, ...model } = { ...testModel, ...overrides };
  return model as unknown as Model;
}

function createAssistantError(errorMessage: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: testModel.api,
    provider: testModel.provider,
    model: testModel.id,
    usage: createZeroUsageFixture(),
    stopReason: "error",
    errorMessage,
    timestamp: 1,
  };
}

function createRecoveredAssistantStream() {
  return createAssistantResultStream({
    ...createAssistantError(""),
    content: [{ type: "text", text: "recovered" }],
    stopReason: "stop",
    errorMessage: undefined,
  });
}

function createTestModelRegistry(authStorage = AuthStorage.inMemory()): ModelRegistry {
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  for (const api of ["openai-responses", "bedrock-converse-stream"] as const) {
    modelRegistry.registerProvider(`test-${api}`, {
      api,
      streamSimple: streamMocks.streamSimple,
    });
  }
  return modelRegistry;
}

async function createSdkSession(options: Partial<Parameters<typeof createAgentSession>[0]> = {}) {
  return await createAgentSession({
    ...options,
    systemPrompt: options.systemPrompt ?? "Test session prompt",
    thinkingLevel: options.thinkingLevel ?? "medium",
    model: options.model ?? testModel,
    tools: options.tools ?? options.customTools?.map((tool) => tool.name) ?? [],
    resourceLoader: options.resourceLoader ?? (await createResourceLoader()),
    sessionManager: options.sessionManager ?? SessionManager.inMemory(),
    settingsManager: options.settingsManager ?? SettingsManager.inMemory(),
    modelRegistry: options.modelRegistry ?? ModelRegistry.inMemory(AuthStorage.inMemory()),
  });
}

async function createSessionAndStreamModel(model: Model): Promise<SimpleStreamOptions> {
  streamMocks.streamSimple.mockReset().mockImplementation(createRecoveredAssistantStream);
  const { session } = await createSdkSession({
    model,
    modelRegistry: createTestModelRegistry(),
  });

  await session.agent.streamFn?.(model, { messages: [], systemPrompt: "", tools: [] }, {});

  return streamMocks.streamSimple.mock.lastCall?.[2] ?? {};
}

function createSessionManagerWithPersistedAssistantMessages(
  messages: Array<{
    content: unknown;
    stopReason?: "stop" | "aborted";
  }>,
): SessionManager {
  const timestamp = new Date().toISOString();
  return SessionManager.fromEntries([
    {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: "sdk-persisted-content",
      timestamp,
      cwd: process.cwd(),
    },
    ...messages.map((message, index) => ({
      type: "message",
      id: `assistant-${String(index + 1)}`,
      parentId: index === 0 ? null : `assistant-${String(index)}`,
      timestamp,
      message: {
        role: "assistant",
        content: message.content,
        api: "messages",
        provider: "anthropic",
        model: "sonnet-4.6",
        usage: createZeroUsageFixture(),
        stopReason: message.stopReason ?? "stop",
        timestamp: Date.now(),
      },
    })),
  ]);
}

async function createSessionFromManager(sessionManager: SessionManager) {
  const { session } = await createSdkSession({ sessionManager });
  return session;
}

function createTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: "custom_lookup",
    label: "Custom Lookup",
    description: "Looks up a test value.",
    promptSnippet: "Lookup test values",
    promptGuidelines: ["Use custom_lookup for test values."],
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
    ...overrides,
  };
}

async function createSettledSession(handlers?: ExtensionFactory) {
  const events: string[] = [];
  const sessionManager = SessionManager.inMemory();
  const { session } = await createSdkSession({
    sessionManager,
    resourceLoader: await createResourceLoader(handlers),
    withSessionWriteSettlement: async (run) => {
      events.push("settlement:start");
      try {
        return await run();
      } finally {
        events.push("settlement:end");
      }
    },
  });
  return { session, sessionManager, events };
}

describe("AgentSession getLastAssistantText", () => {
  it("returns no assistant text for null content", async () => {
    const session = await createSessionFromManager(
      createSessionManagerWithPersistedAssistantMessages([{ content: null }]),
    );
    expect(session.getLastAssistantText()).toBeUndefined();
  });

  it("skips aborted malformed content and returns the preceding assistant text", async () => {
    const sessionManager = createSessionManagerWithPersistedAssistantMessages([
      { content: "previous answer" },
      { content: null, stopReason: "aborted" },
    ]);
    const session = await createSessionFromManager(sessionManager);

    expect(session.getLastAssistantText()).toBe("previous answer");
  });
});

it("applies changing image settings to inline and deferred images without altering parent facts", async () => {
  const settingsManager = SettingsManager.inMemory();
  const { session } = await createSdkSession({ settingsManager });
  const image: ImageContent = { type: "image", data: "cHJpdmF0ZQ==", mimeType: "image/png" };
  const user = attachRuntimePromptMediaFacts(makeUserMessage("Deferred attachment", 1), [
    { path: "/synthetic/private.png", contentType: "image/png" },
    { path: "/synthetic/video.mp4", contentType: "video/mp4" },
  ]);
  const messages: AgentMessage[] = [
    user,
    {
      role: "toolResult",
      toolCallId: "read-image",
      toolName: "read",
      isError: false,
      content: [image, image],
      timestamp: 2,
    },
    { role: "user", content: [image], timestamp: 3 },
  ];
  expect((await session.agent.convertToLlm(messages))[0]).toBe(user);
  settingsManager.applyOverrides({ images: { blockImages: true } });
  const blocked = await session.agent.convertToLlm(messages);
  expect(blocked.map((message) => message.content)).toEqual([
    [
      { type: "text", text: "Deferred attachment" },
      { type: "text", text: "Image reading is disabled." },
    ],
    [{ type: "text", text: "Image reading is disabled." }],
    [{ type: "text", text: "Image reading is disabled." }],
  ]);
  expect(readRuntimePromptMediaFacts(blocked[0]!)).toEqual([
    expect.objectContaining({ path: "/synthetic/private.png", hydrationSuppressed: true }),
    expect.objectContaining({ path: "/synthetic/video.mp4", kind: "video" }),
  ]);
  expect(readRuntimePromptMediaFacts(blocked[0]!)?.[1]?.hydrationSuppressed).toBeUndefined();
  expect(readRuntimePromptMediaFacts(user)?.[0]?.hydrationSuppressed).toBeUndefined();
  expect(messages[1]).toMatchObject({ content: [image, image] });
  settingsManager.applyOverrides({ images: { blockImages: false } });
  expect((await session.agent.convertToLlm(messages))[1]?.content).toEqual([image, image]);
});

describe("AgentSession queued user turns", () => {
  it("preserves prompt image ownership across steered and follow-up messages", async () => {
    const session = await createSessionFromManager(SessionManager.inMemory());
    const steer = vi
      .spyOn(session.agent, "admitSteeringMessage")
      .mockImplementation(() => () => {});
    const followUp = vi.spyOn(session.agent, "followUp").mockImplementation(() => undefined);
    const media = [{ path: "/tmp/a.png", contentType: "image/png" }];
    const imageOrder = ["inline"] as const;
    const image: ImageContent = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
    const { images } = finalizeRuntimePromptImages([{ image, factIndex: 0 }]);

    await session.steer("[media attached: /tmp/a.png (image/png)]", images, undefined, media, [
      ...imageOrder,
    ]);

    const runtimeMessage = steer.mock.calls[0]?.[0];
    const mediaSymbol = Object.getOwnPropertySymbols(runtimeMessage ?? {}).find(
      (symbol) => Symbol.keyFor(symbol) === "openclaw.runtimePromptMediaFacts",
    );
    assert(runtimeMessage && mediaSymbol, "expected runtime prompt media message and symbol");
    expect(Reflect.get(runtimeMessage, mediaSymbol)).toEqual([
      expect.objectContaining({ path: "/tmp/a.png", contentType: "image/png", kind: "image" }),
    ]);
    expect(readRuntimePromptMediaFacts(runtimeMessage)).toHaveProperty("imageOrder", imageOrder);
    expect(Reflect.get(runtimeMessage, "__openclaw")).toEqual({
      mediaImageBlockFactIndexes: [0],
    });
    expect(JSON.stringify(runtimeMessage)).not.toContain("runtimePromptMediaFacts");
    await session.followUp("inspect queued attachment", images);
    expect(followUp.mock.calls[0]?.[0]).toMatchObject({
      __openclaw: { mediaImageBlockFactIndexes: [0] },
    });
  });
});

describe("createAgentSession attribution headers", () => {
  const cloudflare = { "User-Agent": "openclaw" };
  const openrouter = {
    "HTTP-Referer": "https://openclaw.ai",
    "X-OpenRouter-Title": "OpenClaw",
    "X-OpenRouter-Categories": "personal-agent,cli-agent",
  };
  it.each([
    ["amazon-bedrock", undefined, false, undefined],
    ["openrouter", "https://example.test", true, undefined],
    ["custom-openai", "https://openrouter.ai/api/v1", true, openrouter],
    ["cloudflare-workers-ai", "https://example.test", false, cloudflare],
    [
      "custom-openai",
      "https://gateway.ai.cloudflare.com/v1/account/gateway/openai",
      false,
      cloudflare,
    ],
  ] as const)(
    "selects %s attribution for endpoint %s (telemetry off=%s)",
    async (provider, baseUrl, telemetryOff, headers) => {
      if (telemetryOff) {
        vi.stubEnv("OPENCLAW_TELEMETRY", "0");
      }
      try {
        const model =
          baseUrl === undefined
            ? createModelWithoutBaseUrl({
                id: "global.anthropic.claude-sonnet-4-6",
                provider,
                api: "bedrock-converse-stream",
              })
            : { ...testModel, provider, baseUrl };
        const options = await createSessionAndStreamModel(model);
        expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
        if (headers === undefined) {
          expect(options.headers).toBeUndefined();
        } else {
          expect(options.headers).toMatchObject(headers);
        }
      } finally {
        if (telemetryOff) {
          vi.unstubAllEnvs();
        }
      }
    },
  );
});

describe("createAgentSession tool defaults", () => {
  it("keeps tool activation within the prepared allowlist", async () => {
    const customTool = createTool({ hideFromChannelProgress: true });

    const { session } = await createSdkSession({
      tools: ["custom_lookup"],
      customTools: [customTool, { ...customTool, name: "unlisted_tool" }],
    });

    expect(session.getActiveToolNames()).toEqual(["custom_lookup"]);
    expect(session.agent.state.tools).toEqual([
      expect.objectContaining({ name: "custom_lookup", hideFromChannelProgress: true }),
    ]);
    expect(session.getAllTools().map((tool) => tool.name)).toEqual(["custom_lookup"]);

    session.setActiveToolsByName(["bash", "unlisted_tool", "custom_lookup"]);

    expect(session.getActiveToolNames()).toEqual(["custom_lookup"]);
  });

  it("preserves an exact base system prompt when active tools change", async () => {
    const customTool = createTool({
      promptSnippet: "  Lookup\n test  values  ",
      promptGuidelines: [
        " Use custom_lookup for test values. ",
        "",
        "Use custom_lookup for test values.",
      ],
    });

    const systemPrompt = "You are a personal assistant running inside OpenClaw.";
    const authStorage = AuthStorage.inMemory();
    authStorage.setRuntimeApiKey(testModel.provider, "test-api-key");
    const observed: unknown[] = [];
    const handlers: ExtensionFactory = (api) => {
      api.on("before_agent_start", async (event: unknown) => {
        observed.push(event);
      });
    };
    const { session } = await createSdkSession({
      systemPrompt,
      modelRegistry: ModelRegistry.inMemory(authStorage),
      customTools: [customTool],
      resourceLoader: await createResourceLoader(handlers),
    });

    expect(session.systemPrompt).toBe(systemPrompt);
    session.setActiveToolsByName(["bash", "custom_lookup"]);

    expect(session.getActiveToolNames()).toEqual(["custom_lookup"]);
    expect(session.systemPrompt).toBe(systemPrompt);

    vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
    await session.prompt("Inspect the active tool context.");
    expect(observed).toEqual([
      expect.objectContaining({
        systemPrompt,
        systemPromptOptions: expect.objectContaining({
          customPrompt: systemPrompt,
          selectedTools: ["custom_lookup"],
          toolSnippets: { custom_lookup: "Lookup test values" },
          promptGuidelines: ["Use custom_lookup for test values."],
        }),
      }),
    ]);
  });

  it("keeps the public manual compaction result inside its write settlement", async () => {
    const observed: unknown[] = [];
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendMessage(makeUserMessage("Earlier context. ".repeat(100), 1));
    sessionManager.appendMessage(makeUserMessage("Current question", 2));
    const authStorage = AuthStorage.inMemory();
    authStorage.setRuntimeApiKey(testModel.provider, "test-api-key");
    const { session } = await createSdkSession({
      sessionManager,
      modelRegistry: createTestModelRegistry(authStorage),
      settingsManager: SettingsManager.inMemory({ compaction: { keepRecentTokens: 1 } }),
      resourceLoader: await createResourceLoader(createCompactionExtension()),
      withSessionWriteSettlement: async (run) => {
        const result = await run();
        observed.push(result);
        return result;
      },
    });
    try {
      const result = await session.compact();
      expect(result.summary).toBe("condensed history");
      expect(observed).toEqual([result]);
    } finally {
      session.dispose();
    }
  });

  it("runs session message persistence under the configured write settlement", async () => {
    const { session, sessionManager, events } = await createSettledSession();

    const handleAgentEvent = (
      session as unknown as { handleAgentEvent(event: unknown): Promise<void> }
    )["handleAgentEvent"];

    await handleAgentEvent({
      type: "message_end",
      message: makeUserMessage("hello", Date.now()),
    });

    expect(events).toEqual(["settlement:start", "settlement:end"]);
    expect(sessionManager.getEntries().some((entry) => entry.type === "message")).toBe(true);
  });

  it.each(["after_provider_response", "tool_call", "no_hook"] as const)(
    "settles %s inside the write boundary",
    async (hook) => {
      const { session, events } = await createSettledSession(
        hook === "no_hook"
          ? undefined
          : (api) => {
              const recordHook = async () => {
                events.push("hook");
                return undefined;
              };
              if (hook === "after_provider_response") {
                api.on("after_provider_response", recordHook);
              } else {
                api.on("tool_call", recordHook);
              }
            },
      );
      if (hook === "after_provider_response") {
        await session.agent.onResponse?.({ status: 200, headers: {} }, testModel);
      } else {
        await session.agent.beforeToolCall?.({
          assistantMessage: { ...createAssistantError(""), stopReason: "toolUse" },
          toolCall: {
            type: "toolCall",
            id: "call_1",
            name: hook === "no_hook" ? "write_file" : "read",
            arguments: {},
          },
          args: {},
          context: { systemPrompt: "", messages: [], tools: [] },
        });
      }
      expect(events).toEqual([
        "settlement:start",
        ...(hook === "no_hook" ? [] : ["hook"]),
        "settlement:end",
      ]);
    },
  );
});

describe("createAgentSession thinking level clamping", () => {
  it("records declared max thinking in a new embedded session", async () => {
    const sessionManager = SessionManager.inMemory();
    const { session } = await createSdkSession({
      cleanupProviderSessionResourcesOnDispose: false,
      model: {
        ...testModel,
        id: "custom-reasoner",
        reasoning: true,
        thinkingLevelMap: { off: null, minimal: null },
        compat: { supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"] },
      },
      thinkingLevel: "max",
      sessionManager,
      modelRegistry: createTestModelRegistry(),
    });
    try {
      expect({
        level: session.thinkingLevel,
        recorded: sessionManager
          .getEntries()
          .filter((entry) => entry.type === "thinking_level_change")
          .map((entry) => entry.thinkingLevel),
      }).toEqual({ level: "max", recorded: ["max"] });
    } finally {
      session.dispose();
    }
  });
});

describe("AgentSession retry behavior", () => {
  async function createRetrySession(retry?: { baseDelayMs: number; maxRetries: number }) {
    const authStorage = AuthStorage.inMemory();
    authStorage.setRuntimeApiKey(testModel.provider, "test-api-key");
    return await createSdkSession({
      // Retry-only cases need room for the prompt and compaction reserve.
      model: { ...testModel, contextWindow: 32_768 },
      settingsManager: SettingsManager.inMemory({
        retry: retry ?? { baseDelayMs: 0, maxRetries: 1 },
      }),
      modelRegistry: createTestModelRegistry(authStorage),
    });
  }

  it.each(["permanent", "transient", "refusal"])("handles %s provider errors", async (kind) => {
    const error = createAssistantError(
      kind === "permanent"
        ? "model model-x-500-preview not found"
        : "HTTP 503 temporary provider response",
    );
    if (kind === "refusal") {
      error.diagnostics = [
        {
          type: "provider_refusal",
          timestamp: 0,
          details: { provider: "anthropic", category: "cyber" },
        },
      ];
    }
    streamMocks.streamSimple
      .mockReset()
      .mockImplementationOnce(() => createAssistantResultStream(error))
      .mockImplementation(createRecoveredAssistantStream);
    const { session } = await createRetrySession();
    const events: string[] = [];
    session.subscribe((event) => events.push(event.type));
    try {
      await session.prompt(`test ${kind} error`);
      expect(streamMocks.streamSimple).toHaveBeenCalledTimes(kind === "transient" ? 2 : 1);
      expect(events.filter((event) => event.startsWith("auto_retry_"))).toEqual(
        kind === "transient" ? ["auto_retry_start", "auto_retry_end"] : [],
      );
    } finally {
      session.dispose();
    }
  });

  it("uses a short server Retry-After as the auto-retry delay floor", async () => {
    vi.useFakeTimers();
    try {
      streamMocks.streamSimple.mockReset();
      streamMocks.streamSimple
        .mockImplementationOnce(() =>
          createAssistantResultStream(
            createAssistantError("HTTP 429: rate limited; Retry-After: 30 seconds"),
          ),
        )
        .mockImplementationOnce(createRecoveredAssistantStream);
      const { session } = await createRetrySession({ baseDelayMs: 2_000, maxRetries: 1 });
      const promptPromise = session.prompt("test Retry-After");
      await vi.advanceTimersByTimeAsync(0);
      expect(streamMocks.streamSimple).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(streamMocks.streamSimple).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await promptPromise;
      expect(streamMocks.streamSimple).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SDK tool outcomes", () => {
  afterEach(resetSecretRedactionRegistryForTest);

  it.each([false, true])(
    "preserves tool outcomes through events, replay, and storage (recovery=%s)",
    async (withRecovery) => {
      await withSessionState("tool-outcomes", async ({ state, scope: target }) => {
        const secret = "fixture-final-tool-outcome-credential";
        const image = {
          type: "image" as const,
          mimeType: "image/png",
          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV1sAAAAASUVORK5CYII=",
        };
        registerSecretValueForRedaction(secret);
        // Binary blocks must remain byte-exact even when their bytes match registered text.
        registerSecretValueForRedaction(image.data);
        const outcomes = [
          {
            name: "returned_error",
            details: { status: "error", error: "capture failed" },
            isError: true,
          },
          { name: "adapted_error", details: {}, throws: true, isError: true },
          { name: "preflight_error", details: {}, preflight: true, isError: true },
          { name: "recovered_tool", details: {}, throws: true, isError: !withRecovery },
          { name: "middleware_error", details: {}, isError: withRecovery },
          {
            name: "completed_command",
            details: { status: "completed", exitCode: 1 },
            isError: false,
          },
          { name: "successful_tool", details: { status: "ok" }, isError: false },
        ];
        const allOutcomes = [...outcomes, { name: "missing_tool", isError: true }];
        const calls = allOutcomes.map((outcome) => ({
          type: "toolCall" as const,
          id: `call_${outcome.name}`,
          name: outcome.name,
          arguments: {},
        }));
        const expected = allOutcomes.map(({ name, isError }) => ({ toolName: name, isError }));
        const handlers: ExtensionFactory = (api) => {
          if (withRecovery) {
            api.on("tool_result", async (event) => {
              const { toolName } = event as ToolResultEvent;
              if (toolName === "recovered_tool") {
                return { isError: false };
              }
              if (toolName === "middleware_error") {
                return {
                  content: [{ type: "text", text: `middleware failed ${secret}` }],
                  details: { status: "error", error: "middleware failed" },
                };
              }
              return undefined;
            });
            api.on("message_end", async (event) => {
              const { message } = event as MessageEndEvent;
              if (message.role !== "toolResult" || message.toolName !== "successful_tool") {
                return undefined;
              }
              const content = message.content.map((block) =>
                block.type === "text"
                  ? Object.assign({}, block, { text: `message-end rewrite ${secret}` })
                  : block,
              );
              return { message: { ...message, content } };
            });
          }
        };
        const { session } = await createSdkSession({
          sessionManager: await SessionManager.openAsync(target, state.agentDir("main")),
          model: loopTestModel,
          tools: outcomes.map((tool) => tool.name),
          customTools: toToolDefinitions(
            outcomes.map((outcome) => {
              const tool: AgentTool = {
                name: outcome.name,
                label: outcome.name,
                description: "Returns a synthetic tool outcome.",
                parameters: Type.Object({}),
                execute: async () => {
                  if (outcome.throws) {
                    throw new Error(`capture failed: ${secret}`);
                  }
                  return {
                    content: [
                      { type: "text", text: `synthetic result ${secret}` },
                      ...(outcome.name === "successful_tool" ? [image] : []),
                    ],
                    details: outcome.details,
                  };
                },
              };
              return outcome.preflight
                ? attachInternalToolExecutionPreparer(tool, async () => {
                    throw new Error(`preflight failed: ${secret}`);
                  })
                : tool;
            }),
          ),
          resourceLoader: await createResourceLoader(handlers),
          settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
        });
        const completed: Array<{ toolName: string; isError: boolean }> = [];
        session.subscribe((event) => {
          if (event.type === "tool_execution_end") {
            completed.push({ toolName: event.toolName, isError: event.isError });
          }
        });
        let replay: Extract<AgentMessage, { role: "toolResult" }>[] = [];
        let firstTurn = true;
        session.agent.streamFn = (_model, context) => {
          if (!firstTurn) {
            replay = context.messages.filter((message) => message.role === "toolResult");
            return createAssistantResultStream(createAssistant(loopTestModel, "done"));
          }
          firstTurn = false;
          return createAssistantResultStream(createAssistant(loopTestModel, calls, "toolUse"));
        };
        try {
          await session.agent.prompt(makeUserMessage("Run the synthetic tools.", 1));
          expect(completed).toHaveLength(expected.length);
          expect(completed).toEqual(expect.arrayContaining(expected));
          expect(replay).toMatchObject(expected);
          const text = replay
            .flatMap((message) =>
              message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])),
            )
            .join("\n");
          expect(text.includes("synthetic result")).toBe(true);
          expect(text.includes("message-end rewrite")).toBe(withRecovery);
          expect(text).toContain(secret);
          expect(replay.flatMap((message) => message.content)).toContainEqual(
            expect.objectContaining({ type: "image", data: image.data }),
          );
          const persistedTarget = session.sessionManager.getSessionTarget();
          assert(persistedTarget, "Expected a saved transcript target");
          const events = SessionManager.open(persistedTarget).getEntries();
          expect(
            events.flatMap((event) =>
              event.type === "message" && event.message.role === "toolResult"
                ? [event.message]
                : [],
            ),
          ).toMatchObject(expected);
        } finally {
          session.dispose();
        }
      });
    },
  );
});
