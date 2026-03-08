import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { HookRunner } from "../../plugins/hooks.js";
import type { PluginHookAgentContext } from "../../plugins/types.js";
import { default as contextHooksExtension } from "./context-hooks.js";
import { getContextHooksRuntime, setContextHooksRuntime } from "./context-hooks/runtime.js";

function makeUser(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: Date.now() };
}

function makeAssistant(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "fake",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

type ContextHandler = (
  event: { messages: AgentMessage[] },
  ctx: ExtensionContext,
) => { messages: AgentMessage[] } | undefined;

function createContextHandler(): ContextHandler {
  let handler: ContextHandler | undefined;
  const api = {
    on: (name: string, fn: unknown) => {
      if (name === "context") {
        handler = fn as ContextHandler;
      }
    },
    appendEntry: (_type: string, _data?: unknown) => {},
  } as unknown as ExtensionAPI;

  contextHooksExtension(api);
  if (!handler) {
    throw new Error("missing context handler");
  }
  return handler;
}

function runContextHandler(
  handler: ContextHandler,
  messages: AgentMessage[],
  sessionManager: unknown,
) {
  return handler({ messages }, {
    model: undefined,
    sessionManager,
  } as unknown as ExtensionContext);
}

function createMockHookRunner(overrides: Partial<HookRunner> = {}): HookRunner {
  return {
    hasHooks: () => false,
    getHookCount: () => 0,
    runBeforeModelResolve: async () => undefined,
    runBeforePromptBuild: async () => undefined,
    runBeforeAgentStart: async () => undefined,
    runLlmInput: async () => {},
    runLlmOutput: async () => {},
    runAgentEnd: async () => {},
    runBeforeCompaction: async () => {},
    runAfterCompaction: async () => {},
    runBeforeReset: async () => {},
    runMessageReceived: async () => {},
    runMessageSending: async () => undefined,
    runMessageSent: async () => {},
    runBeforeToolCall: async () => undefined,
    runAfterToolCall: async () => {},
    runToolResultPersist: () => undefined,
    runBeforeMessageWrite: () => undefined,
    runBeforeContextSend: () => undefined,
    runSessionStart: async () => {},
    runSessionEnd: async () => {},
    runGatewayStart: async () => {},
    runGatewayStop: async () => {},
    ...overrides,
  } as HookRunner;
}

const defaultHookCtx: PluginHookAgentContext = {
  agentId: "test-agent",
  sessionKey: "test-session",
  sessionId: "test-session-id",
  workspaceDir: "/tmp/test",
};

describe("context-hooks", () => {
  it("no-op when no runtime is registered", () => {
    const handler = createContextHandler();
    const sessionManager = {};

    const messages: AgentMessage[] = [makeUser("hello"), makeAssistant("hi")];

    const result = runContextHandler(handler, messages, sessionManager);
    expect(result).toBeUndefined();
  });

  it("no-op when no before_context_send hooks are registered", () => {
    const handler = createContextHandler();
    const sessionManager = {};

    const hookRunner = createMockHookRunner({
      hasHooks: (name) => name !== "before_context_send",
    });

    setContextHooksRuntime(sessionManager, {
      hookRunner,
      hookCtx: defaultHookCtx,
      modelId: "gpt-4",
      provider: "openai",
      contextWindowTokens: 128000,
    });

    const messages: AgentMessage[] = [makeUser("hello"), makeAssistant("hi")];

    const result = runContextHandler(handler, messages, sessionManager);
    expect(result).toBeUndefined();
  });

  it("plugin filters messages via before_context_send", () => {
    const handler = createContextHandler();
    const sessionManager = {};

    const hookRunner = createMockHookRunner({
      hasHooks: (name) => name === "before_context_send",
      runBeforeContextSend: (event) => {
        // Filter: keep only the last message
        return { messages: event.messages.slice(-1) };
      },
    });

    setContextHooksRuntime(sessionManager, {
      hookRunner,
      hookCtx: defaultHookCtx,
      modelId: "gpt-4",
      provider: "openai",
      contextWindowTokens: 128000,
    });

    const messages: AgentMessage[] = [
      makeUser("old message"),
      makeAssistant("old reply"),
      makeUser("new message"),
    ];

    const result = runContextHandler(handler, messages, sessionManager);
    expect(result).toBeDefined();
    expect(result!.messages).toHaveLength(1);
    const msg = result!.messages[0];
    expect(msg.role).toBe("user");
    if (msg.role === "user") {
      expect(msg.content).toBe("new message");
    }
  });

  it("model info is passed correctly in hook event", () => {
    const handler = createContextHandler();
    const sessionManager = {};

    let capturedEvent: { modelId?: string; provider?: string; contextWindowTokens?: number } = {};

    const hookRunner = createMockHookRunner({
      hasHooks: (name) => name === "before_context_send",
      runBeforeContextSend: (event) => {
        capturedEvent = {
          modelId: event.modelId,
          provider: event.provider,
          contextWindowTokens: event.contextWindowTokens,
        };
        return undefined;
      },
    });

    setContextHooksRuntime(sessionManager, {
      hookRunner,
      hookCtx: defaultHookCtx,
      modelId: "claude-sonnet-4-20250514",
      provider: "anthropic",
      contextWindowTokens: 200000,
    });

    const messages: AgentMessage[] = [makeUser("hello")];

    runContextHandler(handler, messages, sessionManager);

    expect(capturedEvent.modelId).toBe("claude-sonnet-4-20250514");
    expect(capturedEvent.provider).toBe("anthropic");
    expect(capturedEvent.contextWindowTokens).toBe(200000);
  });

  it("routed model info is reflected after runtime mutation", () => {
    const handler = createContextHandler();
    const sessionManager = {};

    const capturedEvents: Array<{ modelId: string; provider: string }> = [];

    const hookRunner = createMockHookRunner({
      hasHooks: (name) => name === "before_context_send",
      runBeforeContextSend: (event) => {
        capturedEvents.push({
          modelId: event.modelId,
          provider: event.provider,
        });
        return undefined;
      },
    });

    setContextHooksRuntime(sessionManager, {
      hookRunner,
      hookCtx: defaultHookCtx,
      modelId: "gpt-4",
      provider: "openai",
      contextWindowTokens: 128000,
    });

    const messages: AgentMessage[] = [makeUser("hello")];

    // First call with original model
    runContextHandler(handler, messages, sessionManager);

    // Simulate model routing by mutating runtime
    const runtime = getContextHooksRuntime(sessionManager);
    expect(runtime).not.toBeNull();
    runtime!.modelId = "claude-sonnet-4-20250514";
    runtime!.provider = "anthropic";
    runtime!.contextWindowTokens = 200000;

    // Second call sees routed model
    runContextHandler(handler, messages, sessionManager);

    expect(capturedEvents).toHaveLength(2);
    expect(capturedEvents[0].modelId).toBe("gpt-4");
    expect(capturedEvents[0].provider).toBe("openai");
    expect(capturedEvents[1].modelId).toBe("claude-sonnet-4-20250514");
    expect(capturedEvents[1].provider).toBe("anthropic");
  });

  it("returns undefined when handler returns no messages", () => {
    const handler = createContextHandler();
    const sessionManager = {};

    const hookRunner = createMockHookRunner({
      hasHooks: (name) => name === "before_context_send",
      runBeforeContextSend: () => {
        return undefined;
      },
    });

    setContextHooksRuntime(sessionManager, {
      hookRunner,
      hookCtx: defaultHookCtx,
      modelId: "gpt-4",
      provider: "openai",
      contextWindowTokens: 128000,
    });

    const messages: AgentMessage[] = [makeUser("hello")];

    const result = runContextHandler(handler, messages, sessionManager);
    expect(result).toBeUndefined();
  });
});
