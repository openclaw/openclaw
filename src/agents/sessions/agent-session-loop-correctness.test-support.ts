import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
} from "openclaw/plugin-sdk/llm";
import { afterEach, beforeEach, vi } from "vitest";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";
import { createZeroUsageFixture } from "../test-helpers/usage-fixtures.js";
import { createResourceLoader } from "./agent-session-loop-resource-loader.test-support.js";
import type { AgentSessionEvent } from "./agent-session-types.js";
import { AgentSession } from "./agent-session.js";
import { AuthStorage } from "./auth-storage.js";
import { DEFAULT_THINKING_LEVEL } from "./defaults.js";
import { ModelRegistry, type ProviderConfigInput } from "./model-registry.js";
import { createAgentSession, type CreateAgentSessionOptions } from "./sdk.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

type TestStreamSimple = NonNullable<ProviderConfigInput["streamSimple"]>;
const hoistedStreamMocks = vi.hoisted(() => ({
  streamSimple: vi.fn<TestStreamSimple>(),
}));
export const streamMocks = hoistedStreamMocks;

export const testModel: Model = makeProviderModelFixture({
  id: "test-model",
  name: "Test Model",
  api: "openai-responses",
  provider: "test-provider",
  baseUrl: "https://example.test",
  contextWindow: 32_768,
  maxTokens: 8_192,
});

const sessions: AgentSession[] = [];

export function createAssistant(
  activeModel: Model,
  content: AssistantMessage["content"] | string,
  stopReason: AssistantMessage["stopReason"] = "stop",
  contextTokens = 1,
): AssistantMessage {
  return {
    role: "assistant",
    content: typeof content === "string" ? [{ type: "text", text: content }] : content,
    api: activeModel.api,
    provider: activeModel.provider,
    model: activeModel.id,
    usage: {
      ...createZeroUsageFixture(),
      input: contextTokens,
      output: 1,
      totalTokens: contextTokens + 1,
      contextUsage: {
        state: "available",
        promptTokens: contextTokens,
        totalTokens: contextTokens + 1,
      },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

export function createAssistantResultStream(message: AssistantMessage) {
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

export function holdAssistantResponse(text: string) {
  const response = createAssistantMessageEventStream();
  let released = false;
  return {
    response,
    isReleased: () => released,
    release: () => {
      if (released) {
        return;
      }
      released = true;
      response.push({
        type: "done",
        reason: "stop",
        message: createAssistant(testModel, text),
      });
      response.end();
    },
  };
}

export function createOverflowAssistant(activeModel: Model) {
  const contextWindow = activeModel.contextWindow;
  if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    throw new Error("Overflow fixture requires a finite positive model context window");
  }
  const message = createAssistant(activeModel, "truncated answer", "length", contextWindow);
  message.usage.output = 0;
  return message;
}

export const createAutoCompactionSettings = (
  compaction: Partial<ReturnType<SettingsManager["getCompactionSettings"]>> = {},
) =>
  SettingsManager.inMemory({
    compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 1, ...compaction },
    retry: { enabled: false },
  });

export function mockInvalidThenTextSummary(recoveredText: string) {
  let requests = 0;
  streamMocks.streamSimple.mockImplementation((activeModel: Model) =>
    createAssistantResultStream(
      createAssistant(
        activeModel,
        ++requests === 1
          ? [{ type: "thinking", thinking: "internal summary reasoning" }]
          : [{ type: "text", text: recoveredText }],
      ),
    ),
  );
  return () => requests;
}

type TestSessionOptions = Partial<
  Pick<
    CreateAgentSessionOptions,
    | "systemPrompt"
    | "model"
    | "thinkingLevel"
    | "settingsManager"
    | "sessionManager"
    | "resourceLoader"
    | "customTools"
    | "contextOverflowRecoveryOwner"
    | "resolveCompactionThinkingLevel"
    | "withSessionWriteSettlement"
  >
>;

export async function createTestSession(options: TestSessionOptions = {}) {
  const model = options.model ?? testModel;
  const authStorage = AuthStorage.inMemory();
  authStorage.setRuntimeApiKey(model.provider, "test-api-key");
  const settingsManager =
    options.settingsManager ??
    SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
      defaultThinkingLevel: options.thinkingLevel,
    });
  const sessionManager = options.sessionManager ?? SessionManager.inMemory();
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  modelRegistry.registerProvider(model.provider, {
    api: model.api,
    streamSimple: streamMocks.streamSimple,
  });
  const result = await createAgentSession({
    ...options,
    systemPrompt: options.systemPrompt ?? "Test session prompt",
    model,
    thinkingLevel: settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL,
    tools: options.customTools?.map((tool) => tool.name) ?? [],
    resourceLoader: options.resourceLoader ?? createResourceLoader(),
    sessionManager,
    settingsManager,
    modelRegistry,
    contextOverflowRecoveryOwner: options.contextOverflowRecoveryOwner ?? "session",
    cleanupProviderSessionResourcesOnDispose: !(
      options.contextOverflowRecoveryOwner || options.resolveCompactionThinkingLevel
    ),
  });
  sessions.push(result.session);
  return { ...result, modelRegistry, settingsManager, sessionManager };
}

export async function appendHistory(
  sessionManager: SessionManager,
  assistant: AssistantMessage,
): Promise<void> {
  await sessionManager.appendMessageAsync({
    role: "user",
    content: "old prompt",
    timestamp: Date.now() - 2,
  });
  await sessionManager.appendMessageAsync({ ...assistant, timestamp: Date.now() - 1 });
}

/** Collect compaction_end events in order; both compaction suites assert on them. */
export function collectCompactionEnds(session: {
  subscribe: (listener: (event: AgentSessionEvent) => void) => unknown;
}) {
  const events: Array<Extract<AgentSessionEvent, { type: "compaction_end" }>> = [];
  session.subscribe((event) => {
    if (event.type === "compaction_end") {
      events.push(event);
    }
  });
  return events;
}

export function registerAgentSessionLoopTestLifecycle(): void {
  beforeEach(() => {
    streamMocks.streamSimple.mockReset();
  });

  afterEach(() => {
    sessions.splice(0).forEach((session) => session.dispose());
  });
}
