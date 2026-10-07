import { registerSessionResourceCleanup } from "@openclaw/ai/internal/runtime";
import { createAssistantMessageEventStream, type AssistantMessage } from "openclaw/plugin-sdk/llm";
// Agent session SDK tests cover prepared tool wiring, prompt preservation, and
// session write-settlement behavior.
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { getStreamLlmRuntime } from "../../llm/model-runtime-binding.js";
import type { ImageContent, Model, SimpleStreamOptions } from "../../llm/types.js";
import { readRuntimePromptImageOrder } from "../../media/media-facts.js";
import { finalizeRuntimePromptImages } from "../../media/runtime-prompt-image-provenance.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { createTestUserTurnTranscriptTarget } from "../../sessions/user-turn-transcript.test-support.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { createZeroUsageFixture } from "../test-helpers/usage-fixtures.js";

const streamMocks = vi.hoisted(() => ({
  streamSimple: vi.fn(),
}));
const sdkSessionTempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const dir of sdkSessionTempDirs.dirs) {
      await closeOpenClawAgentDatabasesAsync(dir);
    }
    cleanup();
  }),
);

vi.mock("../../llm/stream.js", () => ({
  streamSimple: streamMocks.streamSimple,
}));
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import { takeRuntimeUserTurnTranscriptContext } from "../../sessions/user-turn-transcript-runtime-context.js";
import {
  createCompactionHandlers,
  createResourceLoader,
} from "./agent-session-loop-resource-loader.test-support.js";
import { AuthStorage } from "./auth-storage.js";
import type { ToolDefinition } from "./extensions/types.js";
import * as publicSessionSdk from "./index.js";
import { getModelRegistryRuntime } from "./model-registry-runtime.js";
import { ModelRegistry } from "./model-registry.js";
import { createAgentSession } from "./sdk.js";
import { CURRENT_SESSION_VERSION, SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

const testModel: Model = {
  id: "test-model",
  name: "Test Model",
  api: "openai-responses",
  provider: "test-provider",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 1000,
};

describe("createAgentSession runtime ownership", () => {
  it("keeps embedded recovery construction out of the public sessions barrel", () => {
    expect(publicSessionSdk).not.toHaveProperty("createAgentSession");
  });

  it.each([false, true, undefined])(
    "honors provider resource cleanup ownership (%s)",
    async (cleanupOnDispose) => {
      const cleanup = vi.fn();
      const unregisterCleanup = registerSessionResourceCleanup(cleanup);
      try {
        const sessionManager = SessionManager.inMemory();
        const { session } = await createAgentSession({
          cleanupProviderSessionResourcesOnDispose: cleanupOnDispose,
          systemPrompt: "Test session prompt",
          tools: [],
          model: testModel,
          thinkingLevel: "medium",
          resourceLoader: createResourceLoader(),
          sessionManager,
          settingsManager: SettingsManager.inMemory(),
          modelRegistry: createTestModelRegistry(),
        });

        session.dispose();

        expect(cleanup).toHaveBeenCalledTimes(cleanupOnDispose === false ? 0 : 1);
      } finally {
        unregisterCleanup();
      }
    },
  );

  it("binds the installed stream wrapper to the model-registry lifecycle", async () => {
    const modelRegistry = createTestModelRegistry();
    const { session } = await createAgentSession({
      systemPrompt: "Test session prompt",
      tools: [],
      model: testModel,
      thinkingLevel: "medium",
      resourceLoader: createResourceLoader(),
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory(),
      modelRegistry,
    });

    expect(getStreamLlmRuntime(session.agent.streamFn)).toBe(
      getModelRegistryRuntime(modelRegistry).llmRuntime,
    );
  });
});

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

function createAssistantResultStream(message: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      stream.push({ type: "error", reason: message.stopReason, error: message });
    } else {
      stream.push({ type: "done", reason: message.stopReason, message });
    }
    stream.end();
  });
  return stream;
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

async function createSdkSession({
  systemPrompt = "Test session prompt",
  customTools,
  tools = customTools?.map((tool) => tool.name) ?? [],
  model = testModel,
  thinkingLevel = "medium",
  resourceLoader = createResourceLoader(),
  sessionManager = SessionManager.inMemory(),
  settingsManager = SettingsManager.inMemory(),
  modelRegistry = ModelRegistry.inMemory(AuthStorage.inMemory()),
  ...options
}: Partial<Parameters<typeof createAgentSession>[0]> = {}) {
  return await createAgentSession({
    ...options,
    systemPrompt,
    tools,
    customTools,
    model,
    thinkingLevel,
    resourceLoader,
    sessionManager,
    settingsManager,
    modelRegistry,
  });
}

async function createSessionAndStreamModel(model: Model): Promise<SimpleStreamOptions> {
  streamMocks.streamSimple.mockClear();
  const { session } = await createSdkSession({
    model,
    modelRegistry: createTestModelRegistry(),
  });

  await session.agent.streamFn?.(
    model,
    {
      messages: [],
      systemPrompt: "",
      tools: [],
    },
    {},
  );

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
  const { session } = await createSdkSession({
    sessionManager,
  });
  return session;
}

async function createSessionWithPersistedAssistantContent(content: unknown) {
  return await createSessionFromManager(
    createSessionManagerWithPersistedAssistantMessages([{ content }]),
  );
}

describe("AgentSession getLastAssistantText", () => {
  it.each([
    {
      name: "legacy string content",
      content: " legacy assistant text ",
      expected: "legacy assistant text",
    },
    {
      name: "normal text blocks",
      content: [
        { type: "thinking", thinking: "hidden" },
        { type: "text", text: "visible " },
        { type: "text", text: "answer" },
      ],
      expected: "visible answer",
    },
    { name: "null content", content: null, expected: undefined },
  ])("reads $name without throwing", async ({ content, expected }) => {
    const session = await createSessionWithPersistedAssistantContent(content);
    expect(session.getLastAssistantText()).toBe(expected);
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

describe("AgentSession tree navigation", () => {
  it("leaves the tree unchanged when branch summarization returns reasoning only", async () => {
    const authStorage = AuthStorage.inMemory();
    authStorage.setRuntimeApiKey(testModel.provider, "test-api-key");
    const sessionManager = SessionManager.inMemory();
    const rootId = sessionManager.appendMessage(makeUserMessage("shared root", 1));
    const abandonedLeafId = sessionManager.appendMessage(makeUserMessage("abandoned branch", 2));
    sessionManager.branch(rootId);
    const targetId = sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "target branch" }],
      api: testModel.api,
      provider: testModel.provider,
      model: testModel.id,
      usage: createZeroUsageFixture(),
      stopReason: "stop",
      timestamp: 3,
    });
    sessionManager.branch(abandonedLeafId);
    streamMocks.streamSimple.mockReset();
    streamMocks.streamSimple.mockImplementation(() =>
      createAssistantResultStream({
        role: "assistant",
        content: [{ type: "thinking", thinking: "internal summary reasoning" }],
        api: testModel.api,
        provider: testModel.provider,
        model: testModel.id,
        usage: createZeroUsageFixture(),
        stopReason: "stop",
        timestamp: 4,
      }),
    );
    const { session } = await createSdkSession({
      sessionManager,
      modelRegistry: createTestModelRegistry(authStorage),
    });
    const entriesBefore = sessionManager.getEntries();
    const leafBefore = sessionManager.getLeafId();

    await expect(session.navigateTree(targetId, { summarize: true })).rejects.toThrow(
      "Branch summary failed: model returned no summary text",
    );

    expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
    expect(sessionManager.getEntries()).toEqual(entriesBefore);
    expect(sessionManager.getLeafId()).toBe(leafBefore);
    expect(sessionManager.getEntries().some((entry) => entry.type === "branch_summary")).toBe(
      false,
    );
    session.dispose();
  });
});

describe("AgentSession queued user turns", () => {
  it("rechecks captured steering ownership after transcript preparation", async () => {
    const session = await createSessionFromManager(SessionManager.inMemory());
    let resolveInput!: () => void;
    const inputReady = new Promise<void>((resolve) => {
      resolveInput = resolve;
    });
    const recorder = createUserTurnTranscriptRecorder({
      resolveInput: async () => {
        await inputReady;
        return { text: "visible prompt" };
      },
      target: createTestUserTurnTranscriptTarget(),
    });
    const steer = vi
      .spyOn(session.agent, "admitSteeringMessage")
      .mockImplementation(() => () => {});
    let canInject = true;
    const queued = session.steer(
      "runtime prompt",
      undefined,
      recorder,
      undefined,
      undefined,
      "queue-identity",
      () => canInject,
    );
    canInject = false;
    resolveInput();

    await expect(queued).rejects.toThrow("active session is finalizing");
    expect(steer).not.toHaveBeenCalled();
  });

  it("carries prepared transcript context on the exact steered message", async () => {
    const session = await createSessionFromManager(SessionManager.inMemory());
    const recorder = createUserTurnTranscriptRecorder({
      input: {
        text: "visible group prompt",
        sender: { id: "user-42", name: "Ada" },
      },
      target: createTestUserTurnTranscriptTarget(),
    });
    const steer = vi
      .spyOn(session.agent, "admitSteeringMessage")
      .mockImplementation(() => () => {});

    await session.steer("runtime group prompt", undefined, recorder);

    const runtimeMessage = steer.mock.calls[0]?.[0];
    expect(runtimeMessage).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "runtime group prompt" }],
    });
    if (!runtimeMessage) {
      throw new Error("expected queued runtime message");
    }
    expect(takeRuntimeUserTurnTranscriptContext(runtimeMessage)).toMatchObject({
      message: {
        role: "user",
        content: "visible group prompt",
        __openclaw: { senderId: "user-42", senderName: "Ada" },
      },
      recorder,
    });
  });

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
    expect(runtimeMessage).toBeDefined();
    const mediaSymbol = Object.getOwnPropertySymbols(runtimeMessage ?? {}).find(
      (symbol) => Symbol.keyFor(symbol) === "openclaw.runtimePromptMediaFacts",
    );
    expect(mediaSymbol).toBeDefined();
    if (!runtimeMessage || !mediaSymbol) {
      throw new Error("expected runtime prompt media message and symbol");
    }
    expect((runtimeMessage as unknown as Record<PropertyKey, unknown>)[mediaSymbol]).toEqual([
      expect.objectContaining({ path: "/tmp/a.png", contentType: "image/png", kind: "image" }),
    ]);
    expect(readRuntimePromptImageOrder(runtimeMessage)).toEqual(imageOrder);
    expect((runtimeMessage as unknown as Record<string, unknown>)["__openclaw"]).toEqual({
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
  it("tolerates Bedrock models that do not expose baseUrl", async () => {
    const options = await createSessionAndStreamModel(
      createModelWithoutBaseUrl({
        id: "global.anthropic.claude-sonnet-4-6",
        provider: "amazon-bedrock",
        api: "bedrock-converse-stream",
      }),
    );

    expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
    expect(options.headers).toBeUndefined();
  });

  it("forwards OpenRouter attribution for openrouter.ai endpoints with telemetry off, but not proxies", async () => {
    vi.stubEnv("OPENCLAW_TELEMETRY", "0");
    try {
      const proxyOptions = await createSessionAndStreamModel({
        ...testModel,
        provider: "openrouter",
        baseUrl: "https://example.test",
      });
      const endpointOptions = await createSessionAndStreamModel({
        ...testModel,
        provider: "custom-openai",
        baseUrl: "https://openrouter.ai/api/v1",
      });

      expect(proxyOptions.headers).toBeUndefined();
      expect(endpointOptions.headers).toMatchObject({
        "HTTP-Referer": "https://openclaw.ai",
        "X-OpenRouter-Title": "OpenClaw",
        "X-OpenRouter-Categories": "personal-agent,cli-agent",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps Cloudflare attribution headers for provider and endpoint matches", async () => {
    const providerOptions = await createSessionAndStreamModel({
      ...testModel,
      provider: "cloudflare-workers-ai",
      baseUrl: "https://example.test",
    });
    const endpointOptions = await createSessionAndStreamModel({
      ...testModel,
      provider: "custom-openai",
      baseUrl: "https://gateway.ai.cloudflare.com/v1/account/gateway/openai",
    });

    expect(providerOptions.headers).toMatchObject({ "User-Agent": "openclaw" });
    expect(endpointOptions.headers).toMatchObject({ "User-Agent": "openclaw" });
  });
});

describe("createAgentSession tool defaults", () => {
  it("forwards max thinking budgets from settings to the agent", async () => {
    const { session } = await createSdkSession({
      settingsManager: SettingsManager.inMemory({
        thinkingBudgets: {
          high: 16_384,
          max: 32_768,
        },
      }),
    });

    expect(session.agent.thinkingBudgets).toEqual({
      high: 16_384,
      max: 32_768,
    });
  });

  it("keeps tool activation within the prepared allowlist", async () => {
    const customTool: ToolDefinition = {
      name: "custom_lookup",
      label: "Custom Lookup",
      description: "Looks up a test value.",
      promptSnippet: "Lookup test values",
      promptGuidelines: ["Use custom_lookup for test values."],
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{ type: "text", text: "ok" }],
        details: {},
      }),
    };

    const { session } = await createSdkSession({
      tools: ["custom_lookup"],
      customTools: [customTool, { ...customTool, name: "unlisted_tool" }],
    });

    expect(session.getActiveToolNames()).toEqual(["custom_lookup"]);
    expect(session.getAllTools().map((tool) => tool.name)).toEqual(["custom_lookup"]);

    session.setActiveToolsByName(["bash", "unlisted_tool", "custom_lookup"]);

    expect(session.getActiveToolNames()).toEqual(["custom_lookup"]);
  });

  it("preserves channel-progress visibility for custom tools", async () => {
    const hiddenTool: ToolDefinition = {
      name: "internal_wait",
      label: "Internal Wait",
      hideFromChannelProgress: true,
      description: "Waits for internal work.",
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{ type: "text", text: "ok" }],
        details: {},
      }),
    };

    const { session } = await createSdkSession({
      customTools: [hiddenTool],
    });

    expect(session.agent.state.tools).toEqual([
      expect.objectContaining({
        name: "internal_wait",
        hideFromChannelProgress: true,
      }),
    ]);
  });

  it("preserves an exact base system prompt when active tools change", async () => {
    const customTool: ToolDefinition = {
      name: "custom_lookup",
      label: "Custom Lookup",
      description: "Looks up a test value.",
      promptSnippet: "  Lookup\n test  values  ",
      promptGuidelines: [
        " Use custom_lookup for test values. ",
        "",
        "Use custom_lookup for test values.",
      ],
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{ type: "text", text: "ok" }],
        details: {},
      }),
    };

    const systemPrompt = "You are a personal assistant running inside OpenClaw.";
    const authStorage = AuthStorage.inMemory();
    authStorage.setRuntimeApiKey(testModel.provider, "test-api-key");
    const observed: unknown[] = [];
    const handlers = new Map([
      [
        "before_agent_start",
        [
          async (event: unknown) => {
            observed.push(event);
          },
        ],
      ],
    ]);
    const { session } = await createSdkSession({
      systemPrompt,
      modelRegistry: ModelRegistry.inMemory(authStorage),
      customTools: [customTool],
      resourceLoader: createResourceLoader(handlers),
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
    sessionManager.appendMessage({
      role: "user",
      content: "Earlier context. ".repeat(100),
      timestamp: 1,
    });
    sessionManager.appendMessage(makeUserMessage("Current question", 2));
    const authStorage = AuthStorage.inMemory();
    authStorage.setRuntimeApiKey(testModel.provider, "test-api-key");
    const { session } = await createSdkSession({
      sessionManager,
      modelRegistry: createTestModelRegistry(authStorage),
      settingsManager: SettingsManager.inMemory({ compaction: { keepRecentTokens: 1 } }),
      resourceLoader: createResourceLoader(createCompactionHandlers()),
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
    // Transcript writes share the caller-provided settlement boundary so
    // concurrent event handlers cannot interleave persistence.
    const events: string[] = [];
    const sessionManager = SessionManager.inMemory();
    const { session } = await createSdkSession({
      sessionManager,
      withSessionWriteSettlement: async (run) => {
        events.push("settlement:start");
        try {
          return await run();
        } finally {
          events.push("settlement:end");
        }
      },
    });

    const handleAgentEvent = (
      session as unknown as { handleAgentEvent(event: unknown): Promise<void> }
    )["handleAgentEvent"];

    await handleAgentEvent({
      type: "message_end",
      message: {
        role: "user",
        content: "hello",
        timestamp: Date.now(),
      },
    });

    expect(events).toEqual(["settlement:start", "settlement:end"]);
    expect(sessionManager.getEntries().some((entry) => entry.type === "message")).toBe(true);
  });

  it("runs provider response hooks under the configured write settlement", async () => {
    const events: string[] = [];
    const handlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>([
      [
        "after_provider_response",
        [
          async () => {
            events.push("hook");
            return undefined;
          },
        ],
      ],
    ]);

    const { session } = await createSdkSession({
      resourceLoader: createResourceLoader(handlers),
      withSessionWriteSettlement: async (run) => {
        events.push("settlement:start");
        try {
          return await run();
        } finally {
          events.push("settlement:end");
        }
      },
    });

    await session.agent.onResponse?.({ status: 200, headers: {} }, testModel);

    expect(events).toEqual(["settlement:start", "hook", "settlement:end"]);
  });

  it("runs write-capable tool hooks under the configured write settlement", async () => {
    const events: string[] = [];
    const handlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>([
      [
        "tool_call",
        [
          async () => {
            events.push("hook");
            return undefined;
          },
        ],
      ],
    ]);

    const { session } = await createSdkSession({
      resourceLoader: createResourceLoader(handlers),
      withSessionWriteSettlement: async (run) => {
        events.push("settlement:start");
        try {
          return await run();
        } finally {
          events.push("settlement:end");
        }
      },
    });

    await session.agent.beforeToolCall?.({
      assistantMessage: {
        role: "assistant",
        content: [],
        api: testModel.api,
        provider: testModel.provider,
        model: testModel.id,
        usage: createZeroUsageFixture(),
        stopReason: "toolUse",
        timestamp: Date.now(),
      },
      toolCall: { type: "toolCall", id: "call_1", name: "read", arguments: {} },
      args: {},
      context: {
        systemPrompt: "",
        messages: [],
        tools: [],
      },
    });

    expect(events).toEqual(["settlement:start", "hook", "settlement:end"]);
  });

  it("fences tool execution when no extension hook is registered", async () => {
    // Write-capable tools still enter the settlement boundary even without hooks;
    // it covers shared session state, not just extension execution.
    const events: string[] = [];
    const { session } = await createSdkSession({
      withSessionWriteSettlement: async (run) => {
        events.push("settlement:start");
        try {
          return await run();
        } finally {
          events.push("settlement:end");
        }
      },
    });

    await session.agent.beforeToolCall?.({
      assistantMessage: {
        role: "assistant",
        content: [],
        api: testModel.api,
        provider: testModel.provider,
        model: testModel.id,
        usage: createZeroUsageFixture(),
        stopReason: "toolUse",
        timestamp: Date.now(),
      },
      toolCall: { type: "toolCall", id: "call_1", name: "write_file", arguments: {} },
      args: {},
      context: {
        systemPrompt: "",
        messages: [],
        tools: [],
      },
    });

    expect(events).toEqual(["settlement:start", "settlement:end"]);
  });
});

describe("createAgentSession thinking level clamping", () => {
  it.each([
    "openai-completions",
    "openai-responses",
    "azure-openai-responses",
    "openai-chatgpt-responses",
  ] as const)("records declared max thinking in a new embedded %s session", async (api) => {
    const sessionManager = SessionManager.inMemory();
    const { session } = await createAgentSession({
      cleanupProviderSessionResourcesOnDispose: false,
      tools: [],
      systemPrompt: "Test session prompt",
      model: {
        ...testModel,
        id: "custom-reasoner",
        api,
        reasoning: true,
        thinkingLevelMap: { off: null, minimal: null },
        compat: { supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"] },
      },
      thinkingLevel: "max",
      resourceLoader: createResourceLoader(),
      sessionManager,
      settingsManager: SettingsManager.inMemory(),
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
      const retryDelays: number[] = [];
      session.subscribe((event) => {
        if (event.type === "auto_retry_start") {
          retryDelays.push(event.delayMs);
        }
      });

      const promptPromise = session.prompt("test Retry-After");
      await vi.advanceTimersByTimeAsync(0);

      expect(retryDelays).toEqual([30_000]);

      await vi.advanceTimersByTimeAsync(30_000);
      await promptPromise;
      expect(streamMocks.streamSimple).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
