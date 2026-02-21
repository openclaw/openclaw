import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the guardian-client module before importing index
vi.mock("./guardian-client.js", () => ({
  callGuardian: vi.fn(),
}));

import type { OpenClawPluginApi, PluginRuntime } from "openclaw/plugin-sdk";
import { callGuardian } from "./guardian-client.js";
import guardianPlugin, { __testing } from "./index.js";
import { clearCache, updateCache } from "./message-cache.js";
import type { GuardianConfig, ResolvedGuardianModel } from "./types.js";

const { reviewToolCall, resolveModelFromConfig, decisionCache } = __testing;

// Minimal logger mock
function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

// Default test config (new shape — no api_base/api_key)
function makeConfig(overrides: Partial<GuardianConfig> = {}): GuardianConfig {
  return {
    model: "test-provider/test-model",
    watched_tools: ["message_send", "message", "exec"],
    timeout_ms: 20000,
    fallback_on_error: "allow",
    log_decisions: true,
    mode: "enforce",
    max_user_messages: 3,
    max_arg_length: 500,
    ...overrides,
  };
}

// Default resolved model for tests
function makeResolvedModel(overrides: Partial<ResolvedGuardianModel> = {}): ResolvedGuardianModel {
  return {
    provider: "test-provider",
    modelId: "test-model",
    baseUrl: "https://api.example.com/v1",
    apiKey: "test-key",
    api: "openai-completions",
    ...overrides,
  };
}

describe("guardian index — reviewToolCall", () => {
  const watchedTools = new Set(["message_send", "message", "exec"]);
  const systemPrompt = "test system prompt";
  const resolvedModel = makeResolvedModel();

  beforeEach(() => {
    clearCache();
    decisionCache.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("allows unwatched tools immediately without calling guardian", async () => {
    const result = await reviewToolCall(
      makeConfig(),
      resolvedModel,
      watchedTools,
      systemPrompt,
      { toolName: "web_fetch", params: { url: "https://example.com" } },
      { sessionKey: "s1", toolName: "web_fetch" },
      makeLogger(),
    );

    expect(result).toBeUndefined();
    expect(callGuardian).not.toHaveBeenCalled();
  });

  it("calls guardian and blocks when guardian says BLOCK", async () => {
    updateCache("s1", [{ role: "user", content: "What about API keys?" }], undefined, 3);

    vi.mocked(callGuardian).mockResolvedValue({
      action: "block",
      reason: "user never asked to send a message",
    });

    const result = await reviewToolCall(
      makeConfig(),
      resolvedModel,
      watchedTools,
      systemPrompt,
      { toolName: "message_send", params: { target: "security-alerts", message: "test" } },
      { sessionKey: "s1", toolName: "message_send" },
      makeLogger(),
    );

    expect(result).toEqual({
      block: true,
      blockReason: "Guardian: user never asked to send a message",
    });
    expect(callGuardian).toHaveBeenCalledOnce();
  });

  it("calls guardian and allows when guardian says ALLOW", async () => {
    updateCache("s1", [{ role: "user", content: "Send hello to Alice" }], undefined, 3);

    vi.mocked(callGuardian).mockResolvedValue({ action: "allow" });

    const result = await reviewToolCall(
      makeConfig(),
      resolvedModel,
      watchedTools,
      systemPrompt,
      { toolName: "message_send", params: { target: "Alice", message: "hello" } },
      { sessionKey: "s1", toolName: "message_send" },
      makeLogger(),
    );

    expect(result).toBeUndefined();
    expect(callGuardian).toHaveBeenCalledOnce();
  });

  it("passes resolved model to callGuardian", async () => {
    updateCache("s1", [{ role: "user", content: "test" }], undefined, 3);
    vi.mocked(callGuardian).mockResolvedValue({ action: "allow" });

    const model = makeResolvedModel({ provider: "kimi", modelId: "moonshot-v1-8k" });

    await reviewToolCall(
      makeConfig(),
      model,
      watchedTools,
      systemPrompt,
      { toolName: "exec", params: { command: "ls" } },
      { sessionKey: "s1", toolName: "exec" },
      makeLogger(),
    );

    expect(callGuardian).toHaveBeenCalledWith(
      expect.objectContaining({
        model,
        timeoutMs: 20000,
        fallbackOnError: "allow",
      }),
    );
  });

  it("uses decision cache for repeated calls to same tool in same session", async () => {
    updateCache("s1", [{ role: "user", content: "What about API keys?" }], undefined, 3);

    vi.mocked(callGuardian).mockResolvedValue({
      action: "block",
      reason: "not requested",
    });

    // First call — hits guardian
    await reviewToolCall(
      makeConfig(),
      resolvedModel,
      watchedTools,
      systemPrompt,
      { toolName: "message_send", params: { target: "x" } },
      { sessionKey: "s1", toolName: "message_send" },
      makeLogger(),
    );

    // Second call — should use cache
    const result = await reviewToolCall(
      makeConfig(),
      resolvedModel,
      watchedTools,
      systemPrompt,
      { toolName: "message_send", params: { target: "y" } },
      { sessionKey: "s1", toolName: "message_send" },
      makeLogger(),
    );

    expect(callGuardian).toHaveBeenCalledOnce();
    expect(result).toEqual({
      block: true,
      blockReason: "Guardian: not requested",
    });
  });

  it("in audit mode, logs BLOCK but does not actually block", async () => {
    updateCache("s1", [{ role: "user", content: "What about API keys?" }], undefined, 3);

    vi.mocked(callGuardian).mockResolvedValue({
      action: "block",
      reason: "not requested",
    });

    const logger = makeLogger();

    const result = await reviewToolCall(
      makeConfig({ mode: "audit" }),
      resolvedModel,
      watchedTools,
      systemPrompt,
      { toolName: "message_send", params: { target: "security-alerts" } },
      { sessionKey: "s1", toolName: "message_send" },
      logger,
    );

    expect(result).toBeUndefined();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("AUDIT-ONLY"));
  });

  it("applies fallback when session context is unknown", async () => {
    const result = await reviewToolCall(
      makeConfig({ fallback_on_error: "block" }),
      resolvedModel,
      watchedTools,
      systemPrompt,
      { toolName: "exec", params: { command: "rm -rf /" } },
      { toolName: "exec" }, // no sessionKey
      makeLogger(),
    );

    expect(result).toEqual({
      block: true,
      blockReason: "Guardian: no session context available",
    });
    expect(callGuardian).not.toHaveBeenCalled();
  });

  it("logs decisions when log_decisions is true", async () => {
    updateCache("s1", [{ role: "user", content: "Send hello" }], undefined, 3);
    vi.mocked(callGuardian).mockResolvedValue({ action: "allow" });

    const logger = makeLogger();

    await reviewToolCall(
      makeConfig({ log_decisions: true }),
      resolvedModel,
      watchedTools,
      systemPrompt,
      { toolName: "message_send", params: { target: "Alice" } },
      { sessionKey: "s1", toolName: "message_send" },
      logger,
    );

    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("[guardian] ALLOW"));
  });

  it("does not log when log_decisions is false", async () => {
    updateCache("s1", [{ role: "user", content: "Send hello" }], undefined, 3);
    vi.mocked(callGuardian).mockResolvedValue({ action: "allow" });

    const logger = makeLogger();

    await reviewToolCall(
      makeConfig({ log_decisions: false }),
      resolvedModel,
      watchedTools,
      systemPrompt,
      { toolName: "message_send", params: { target: "Alice" } },
      { sessionKey: "s1", toolName: "message_send" },
      logger,
    );

    expect(logger.info).not.toHaveBeenCalled();
  });

  it("handles case-insensitive tool name matching", async () => {
    updateCache("s1", [{ role: "user", content: "test" }], undefined, 3);
    vi.mocked(callGuardian).mockResolvedValue({ action: "allow" });

    await reviewToolCall(
      makeConfig(),
      resolvedModel,
      watchedTools,
      systemPrompt,
      { toolName: "Message_Send", params: {} },
      { sessionKey: "s1", toolName: "Message_Send" },
      makeLogger(),
    );

    expect(callGuardian).toHaveBeenCalledOnce();
  });

  it("logs detailed review info including tool params and user message count", async () => {
    updateCache("s1", [{ role: "user", content: "Send hello to Alice" }], undefined, 3);
    vi.mocked(callGuardian).mockResolvedValue({ action: "allow" });

    const logger = makeLogger();

    await reviewToolCall(
      makeConfig({ log_decisions: true }),
      resolvedModel,
      watchedTools,
      systemPrompt,
      { toolName: "message_send", params: { target: "Alice", message: "hello" } },
      { sessionKey: "s1", toolName: "message_send" },
      logger,
    );

    // Should log the review summary with tool name, session, turn count, and params
    const infoMessages = logger.info.mock.calls.map((c: string[]) => c[0]);
    expect(infoMessages.some((m: string) => m.includes("Reviewing tool=message_send"))).toBe(true);
    expect(infoMessages.some((m: string) => m.includes("turns=1"))).toBe(true);
    expect(infoMessages.some((m: string) => m.includes("Alice"))).toBe(true);
  });

  it("passes logger to callGuardian when log_decisions is true", async () => {
    updateCache("s1", [{ role: "user", content: "test" }], undefined, 3);
    vi.mocked(callGuardian).mockResolvedValue({ action: "allow" });

    await reviewToolCall(
      makeConfig({ log_decisions: true }),
      resolvedModel,
      watchedTools,
      systemPrompt,
      { toolName: "exec", params: { command: "ls" } },
      { sessionKey: "s1", toolName: "exec" },
      makeLogger(),
    );

    // callGuardian should receive a logger
    expect(callGuardian).toHaveBeenCalledWith(
      expect.objectContaining({
        logger: expect.any(Object),
      }),
    );
  });

  it("does not pass logger to callGuardian when log_decisions is false", async () => {
    updateCache("s1", [{ role: "user", content: "test" }], undefined, 3);
    vi.mocked(callGuardian).mockResolvedValue({ action: "allow" });

    await reviewToolCall(
      makeConfig({ log_decisions: false }),
      resolvedModel,
      watchedTools,
      systemPrompt,
      { toolName: "exec", params: { command: "ls" } },
      { sessionKey: "s1", toolName: "exec" },
      makeLogger(),
    );

    // callGuardian should NOT receive a logger
    expect(callGuardian).toHaveBeenCalledWith(
      expect.objectContaining({
        logger: undefined,
      }),
    );
  });
});

describe("guardian index — resolveModelFromConfig", () => {
  it("resolves model from inline provider config with baseUrl", () => {
    const result = resolveModelFromConfig("myollama", "llama3.1:8b", {
      models: {
        providers: {
          myollama: {
            baseUrl: "http://localhost:11434/v1",
            api: "openai-completions",
            models: [
              {
                id: "llama3.1:8b",
                name: "Llama 3.1 8B",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 8192,
                maxTokens: 4096,
              },
            ],
          },
        },
      },
    });

    expect(result).toBeDefined();
    expect(result.provider).toBe("myollama");
    expect(result.modelId).toBe("llama3.1:8b");
    expect(result.baseUrl).toBe("http://localhost:11434/v1");
    expect(result.api).toBe("openai-completions");
  });

  it("returns partial model (no baseUrl) for unknown providers — pending SDK resolution", () => {
    const result = resolveModelFromConfig("unknown-provider", "some-model", {});
    expect(result).toBeDefined();
    expect(result.provider).toBe("unknown-provider");
    expect(result.modelId).toBe("some-model");
    expect(result.baseUrl).toBeUndefined();
    expect(result.api).toBe("openai-completions"); // default
  });

  it("returns partial model for known providers not in explicit config — pending SDK resolution", () => {
    const result = resolveModelFromConfig("anthropic", "claude-haiku-4-5", {});
    expect(result).toBeDefined();
    expect(result.provider).toBe("anthropic");
    expect(result.modelId).toBe("claude-haiku-4-5");
    expect(result.baseUrl).toBeUndefined(); // will be resolved via SDK
  });

  it("inline config provider with baseUrl is fully resolved", () => {
    const result = resolveModelFromConfig("openai", "gpt-4o-mini", {
      models: {
        providers: {
          openai: {
            baseUrl: "https://my-proxy.example.com/v1",
            apiKey: "custom-key",
            models: [],
          },
        },
      },
    });

    expect(result).toBeDefined();
    expect(result.baseUrl).toBe("https://my-proxy.example.com/v1");
    expect(result.apiKey).toBe("custom-key");
  });

  it("preserves api type from config even without baseUrl", () => {
    const result = resolveModelFromConfig("anthropic", "claude-haiku-4-5", {
      models: {
        providers: {
          anthropic: {
            baseUrl: "", // empty — treated as missing
            api: "anthropic-messages",
            models: [],
          },
        },
      },
    });

    expect(result.baseUrl).toBeUndefined();
    expect(result.api).toBe("anthropic-messages");
  });
});

describe("guardian index — lazy provider + auth resolution via SDK", () => {
  /** Create a minimal mock of OpenClawPluginApi for testing registration. */
  function makeMockApi(
    overrides: {
      pluginConfig?: Record<string, unknown>;
      resolveApiKeyForProvider?: PluginRuntime["models"]["resolveApiKeyForProvider"];
      resolveProviderInfo?: PluginRuntime["models"]["resolveProviderInfo"];
      openclawConfig?: Record<string, unknown>;
    } = {},
  ) {
    const hooks: Record<string, Array<(...args: unknown[]) => unknown>> = {};

    const mockResolveAuth =
      overrides.resolveApiKeyForProvider ??
      vi.fn().mockResolvedValue({
        apiKey: "sk-mock-key",
        source: "mock",
        mode: "api-key",
      });
    const mockResolveProvider =
      overrides.resolveProviderInfo ??
      vi.fn().mockResolvedValue({
        baseUrl: "https://api.anthropic.com",
        api: "anthropic-messages",
      });

    const api: OpenClawPluginApi = {
      id: "guardian",
      name: "Guardian",
      source: "test",
      config: (overrides.openclawConfig ?? {
        agents: {
          defaults: {
            model: {
              primary: "anthropic/claude-haiku-4-5",
            },
          },
        },
      }) as OpenClawPluginApi["config"],
      pluginConfig: {
        model: "anthropic/claude-haiku-4-5",
        mode: "audit",
        log_decisions: true,
        ...overrides.pluginConfig,
      },
      runtime: {
        models: {
          resolveApiKeyForProvider: mockResolveAuth,
          resolveProviderInfo: mockResolveProvider,
        },
      } as unknown as PluginRuntime,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as unknown as OpenClawPluginApi["logger"],

      // Capture hook registrations
      on: vi.fn((hookName, handler) => {
        if (!hooks[hookName]) hooks[hookName] = [];
        hooks[hookName].push(handler);
      }),
      registerTool: vi.fn(),
      registerHook: vi.fn(),
      registerHttpHandler: vi.fn(),
      registerHttpRoute: vi.fn(),
      registerChannel: vi.fn(),
      registerGatewayMethod: vi.fn(),
      registerCli: vi.fn(),
      registerService: vi.fn(),
      registerProvider: vi.fn(),
      registerCommand: vi.fn(),
      resolvePath: vi.fn((s: string) => s),
    };

    return { api, hooks, mockResolveAuth, mockResolveProvider };
  }

  beforeEach(() => {
    clearCache();
    decisionCache.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves provider info + API key from SDK on first before_tool_call", async () => {
    const mockResolveAuth = vi.fn().mockResolvedValue({
      apiKey: "sk-from-auth-profiles",
      profileId: "anthropic:default",
      source: "profile:anthropic:default",
      mode: "oauth",
    });
    const mockResolveProvider = vi.fn().mockResolvedValue({
      baseUrl: "https://api.anthropic.com",
      api: "anthropic-messages",
    });

    const { api, hooks } = makeMockApi({
      resolveApiKeyForProvider: mockResolveAuth,
      resolveProviderInfo: mockResolveProvider,
    });

    guardianPlugin.register(api);

    expect(hooks["before_tool_call"]).toBeDefined();
    expect(hooks["before_tool_call"]!.length).toBe(1);

    updateCache("s1", [{ role: "user", content: "test message" }], undefined, 3);
    vi.mocked(callGuardian).mockResolvedValue({ action: "allow" });

    const handler = hooks["before_tool_call"]![0];
    await handler(
      { toolName: "exec", params: { command: "ls" } },
      { sessionKey: "s1", toolName: "exec" },
    );

    // Provider info should be resolved
    expect(mockResolveProvider).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "anthropic" }),
    );

    // Auth should be resolved
    expect(mockResolveAuth).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "anthropic" }),
    );

    // callGuardian should receive both baseUrl and apiKey
    expect(callGuardian).toHaveBeenCalledWith(
      expect.objectContaining({
        model: expect.objectContaining({
          baseUrl: "https://api.anthropic.com",
          api: "anthropic-messages",
          apiKey: "sk-from-auth-profiles",
        }),
      }),
    );
  });

  it("skips SDK resolution when explicit config already provides baseUrl + apiKey", async () => {
    const mockResolveAuth = vi.fn();
    const mockResolveProvider = vi.fn();

    const { api, hooks } = makeMockApi({
      resolveApiKeyForProvider: mockResolveAuth,
      resolveProviderInfo: mockResolveProvider,
      openclawConfig: {
        agents: { defaults: { model: { primary: "myapi/model-x" } } },
        models: {
          providers: {
            myapi: {
              baseUrl: "https://my-api.com/v1",
              apiKey: "my-key",
              api: "openai-completions",
              models: [],
            },
          },
        },
      },
      pluginConfig: { model: "myapi/model-x", log_decisions: true },
    });

    guardianPlugin.register(api);

    updateCache("s1", [{ role: "user", content: "test" }], undefined, 3);
    vi.mocked(callGuardian).mockResolvedValue({ action: "allow" });

    const handler = hooks["before_tool_call"]![0];
    await handler(
      { toolName: "exec", params: { command: "ls" } },
      { sessionKey: "s1", toolName: "exec" },
    );

    // Should NOT call resolveProviderInfo or resolveApiKeyForProvider
    // since config provides both baseUrl and apiKey
    expect(mockResolveProvider).not.toHaveBeenCalled();
    expect(mockResolveAuth).not.toHaveBeenCalled();

    expect(callGuardian).toHaveBeenCalledWith(
      expect.objectContaining({
        model: expect.objectContaining({
          baseUrl: "https://my-api.com/v1",
          apiKey: "my-key",
        }),
      }),
    );
  });

  it("only resolves once across multiple before_tool_call invocations", async () => {
    const mockResolveAuth = vi.fn().mockResolvedValue({
      apiKey: "sk-resolved-once",
      source: "profile:anthropic:default",
      mode: "api-key",
    });
    const mockResolveProvider = vi.fn().mockResolvedValue({
      baseUrl: "https://api.anthropic.com",
      api: "anthropic-messages",
    });

    const { api, hooks } = makeMockApi({
      resolveApiKeyForProvider: mockResolveAuth,
      resolveProviderInfo: mockResolveProvider,
    });

    guardianPlugin.register(api);

    updateCache("s1", [{ role: "user", content: "test" }], undefined, 3);
    vi.mocked(callGuardian).mockResolvedValue({ action: "allow" });

    const handler = hooks["before_tool_call"]![0];

    await handler({ toolName: "exec", params: {} }, { sessionKey: "s1", toolName: "exec" });
    decisionCache.clear();
    await handler({ toolName: "exec", params: {} }, { sessionKey: "s1", toolName: "exec" });
    decisionCache.clear();
    await handler({ toolName: "exec", params: {} }, { sessionKey: "s1", toolName: "exec" });

    // Each SDK function should be called only once
    expect(mockResolveProvider).toHaveBeenCalledTimes(1);
    expect(mockResolveAuth).toHaveBeenCalledTimes(1);
  });

  it("handles provider resolution failure — falls back per config", async () => {
    const mockResolveProvider = vi.fn().mockResolvedValue(undefined); // provider not found

    const { api, hooks } = makeMockApi({
      resolveProviderInfo: mockResolveProvider,
      pluginConfig: {
        model: "unknown/model",
        fallback_on_error: "allow",
        log_decisions: true,
      },
    });

    guardianPlugin.register(api);

    updateCache("s1", [{ role: "user", content: "test" }], undefined, 3);

    const handler = hooks["before_tool_call"]![0];
    const result = await handler(
      { toolName: "exec", params: { command: "ls" } },
      { sessionKey: "s1", toolName: "exec" },
    );

    // Should not call callGuardian since provider couldn't be resolved
    expect(callGuardian).not.toHaveBeenCalled();

    // With fallback_on_error: "allow", should return undefined (allow)
    expect(result).toBeUndefined();

    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Provider resolution failed"),
    );
  });

  it("handles auth resolution failure gracefully — still calls guardian", async () => {
    const mockResolveAuth = vi.fn().mockRejectedValue(new Error("No API key found"));
    const mockResolveProvider = vi.fn().mockResolvedValue({
      baseUrl: "https://api.anthropic.com",
      api: "anthropic-messages",
    });

    const { api, hooks } = makeMockApi({
      resolveApiKeyForProvider: mockResolveAuth,
      resolveProviderInfo: mockResolveProvider,
    });

    guardianPlugin.register(api);

    updateCache("s1", [{ role: "user", content: "test" }], undefined, 3);
    vi.mocked(callGuardian).mockResolvedValue({
      action: "allow",
      reason: "Guardian unavailable (fallback: allow)",
    });

    const handler = hooks["before_tool_call"]![0];
    await handler(
      { toolName: "exec", params: { command: "ls" } },
      { sessionKey: "s1", toolName: "exec" },
    );

    // Provider resolved, but auth failed — should still call callGuardian
    expect(callGuardian).toHaveBeenCalled();

    expect(api.logger.warn).toHaveBeenCalledWith(expect.stringContaining("Auth resolution failed"));
  });
});
