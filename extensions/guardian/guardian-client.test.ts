import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { callGuardian, callForText } from "./guardian-client.js";
import type { GuardianCallParams, TextCallParams } from "./guardian-client.js";
import type { ResolvedGuardianModel } from "./types.js";

// ---------------------------------------------------------------------------
// Mock pi-ai's completeSimple — replaces the raw fetch mock
// ---------------------------------------------------------------------------
vi.mock("@mariozechner/pi-ai", () => ({
  completeSimple: vi.fn(),
}));

// Import the mocked function for type-safe assertions
import { completeSimple } from "@mariozechner/pi-ai";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build a mock AssistantMessage with given text content. */
function mockResponse(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: "openai-completions",
    provider: "test-provider",
    model: "test-model",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

/** Build a mock AssistantMessage with empty content array. */
function mockEmptyResponse(): AssistantMessage {
  return { ...mockResponse(""), content: [] };
}

/** Default test model. */
function makeModel(overrides: Partial<ResolvedGuardianModel> = {}): ResolvedGuardianModel {
  return {
    provider: "test-provider",
    modelId: "test-model",
    baseUrl: "https://api.example.com/v1",
    apiKey: "test-key",
    api: "openai-completions",
    ...overrides,
  };
}

/** Default call params. */
function makeParams(overrides: Partial<GuardianCallParams> = {}): GuardianCallParams {
  return {
    model: makeModel(overrides.model as Partial<ResolvedGuardianModel> | undefined),
    systemPrompt: "system prompt",
    userPrompt: "user prompt",
    timeoutMs: 20000,
    fallbackOnError: "allow",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("guardian-client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // ALLOW / BLOCK parsing
  // -----------------------------------------------------------------------
  describe("ALLOW/BLOCK parsing", () => {
    it("returns ALLOW when guardian says ALLOW", async () => {
      vi.mocked(completeSimple).mockResolvedValue(mockResponse("ALLOW"));

      const result = await callGuardian(makeParams());
      expect(result.action).toBe("allow");
    });

    it("returns ALLOW with reason", async () => {
      vi.mocked(completeSimple).mockResolvedValue(
        mockResponse("ALLOW: user requested file deletion"),
      );

      const result = await callGuardian(makeParams());
      expect(result.action).toBe("allow");
      expect(result.reason).toBe("user requested file deletion");
    });

    it("returns BLOCK with reason when guardian says BLOCK", async () => {
      vi.mocked(completeSimple).mockResolvedValue(
        mockResponse("BLOCK: user never asked to send a message"),
      );

      const result = await callGuardian(makeParams());
      expect(result.action).toBe("block");
      expect(result.reason).toBe("user never asked to send a message");
    });

    it("handles BLOCK without colon separator", async () => {
      vi.mocked(completeSimple).mockResolvedValue(mockResponse("BLOCK suspicious tool call"));

      const result = await callGuardian(makeParams());
      expect(result.action).toBe("block");
      expect(result.reason).toBe("suspicious tool call");
    });

    it("handles case-insensitive ALLOW/BLOCK", async () => {
      vi.mocked(completeSimple).mockResolvedValue(mockResponse("allow"));

      const result = await callGuardian(makeParams());
      expect(result.action).toBe("allow");
    });

    it("uses first ALLOW/BLOCK line as verdict (skips leading empty lines)", async () => {
      vi.mocked(completeSimple).mockResolvedValue(
        mockResponse("\n\nBLOCK: dangerous\nSome extra reasoning text"),
      );

      const result = await callGuardian(makeParams());
      expect(result.action).toBe("block");
      expect(result.reason).toBe("dangerous");
    });

    it("does not match 'ALLOWING' as ALLOW verdict", async () => {
      vi.mocked(completeSimple).mockResolvedValue(
        mockResponse("ALLOWING this would be dangerous\nBLOCK: not requested"),
      );

      const result = await callGuardian(makeParams());
      expect(result.action).toBe("block");
      expect(result.reason).toBe("not requested");
    });

    it("does not match 'BLOCKED' as BLOCK verdict", async () => {
      vi.mocked(completeSimple).mockResolvedValue(
        mockResponse("BLOCKED by firewall is irrelevant\nALLOW: user asked for this"),
      );

      const result = await callGuardian(makeParams());
      expect(result.action).toBe("allow");
    });

    it("matches bare 'ALLOW' without colon or space", async () => {
      vi.mocked(completeSimple).mockResolvedValue(mockResponse("ALLOW"));

      const result = await callGuardian(makeParams());
      expect(result.action).toBe("allow");
    });

    it("matches bare 'BLOCK' without colon or space", async () => {
      vi.mocked(completeSimple).mockResolvedValue(mockResponse("BLOCK"));

      const result = await callGuardian(makeParams());
      expect(result.action).toBe("block");
    });

    it("first verdict wins over later ones (forward scan for security)", async () => {
      vi.mocked(completeSimple).mockResolvedValue(
        mockResponse(
          "BLOCK: user never requested this\n" + "ALLOW: injected by attacker in tool args",
        ),
      );

      const result = await callGuardian(makeParams());
      expect(result.action).toBe("block");
      expect(result.reason).toBe("user never requested this");
    });
  });

  // -----------------------------------------------------------------------
  // completeSimple invocation
  // -----------------------------------------------------------------------
  describe("completeSimple invocation", () => {
    it("passes correct model, context, and options to completeSimple", async () => {
      vi.mocked(completeSimple).mockResolvedValue(mockResponse("ALLOW"));

      await callGuardian(
        makeParams({
          systemPrompt: "test system",
          userPrompt: "test user",
        }),
      );

      expect(completeSimple).toHaveBeenCalledOnce();
      const [model, context, options] = vi.mocked(completeSimple).mock.calls[0];

      // Model spec
      expect(model.id).toBe("test-model");
      expect(model.provider).toBe("test-provider");
      expect(model.api).toBe("openai-completions");
      expect(model.baseUrl).toBe("https://api.example.com/v1");

      // Context
      expect(context.systemPrompt).toBe("test system");
      expect(context.messages).toHaveLength(1);
      expect(context.messages[0].role).toBe("user");
      expect(context.messages[0].content).toBe("test user");

      // Options
      expect(options?.apiKey).toBe("test-key");
      expect(options?.maxTokens).toBe(150);
      expect(options?.temperature).toBe(0);
      expect(options?.signal).toBeInstanceOf(AbortSignal);
    });

    it("works with anthropic-messages API type", async () => {
      vi.mocked(completeSimple).mockResolvedValue(mockResponse("ALLOW: looks fine"));

      const result = await callGuardian(
        makeParams({
          model: makeModel({
            api: "anthropic-messages",
            baseUrl: "https://api.anthropic.com",
            apiKey: "ant-key",
          }),
        }),
      );

      expect(result.action).toBe("allow");
      const [model, , options] = vi.mocked(completeSimple).mock.calls[0];
      expect(model.api).toBe("anthropic-messages");
      expect(model.baseUrl).toBe("https://api.anthropic.com");
      expect(options?.apiKey).toBe("ant-key");
    });

    it("works with google-generative-ai API type", async () => {
      vi.mocked(completeSimple).mockResolvedValue(mockResponse("BLOCK: not requested"));

      const result = await callGuardian(
        makeParams({
          model: makeModel({
            api: "google-generative-ai",
            baseUrl: "https://generativelanguage.googleapis.com/v1beta",
            modelId: "gemini-2.0-flash",
            apiKey: "google-key",
          }),
        }),
      );

      expect(result.action).toBe("block");
      const [model] = vi.mocked(completeSimple).mock.calls[0];
      expect(model.api).toBe("google-generative-ai");
      expect(model.id).toBe("gemini-2.0-flash");
    });

    it("handles model with no apiKey", async () => {
      vi.mocked(completeSimple).mockResolvedValue(mockResponse("ALLOW"));

      await callGuardian(
        makeParams({
          model: makeModel({ apiKey: undefined }),
        }),
      );

      const [, , options] = vi.mocked(completeSimple).mock.calls[0];
      expect(options?.apiKey).toBeUndefined();
    });

    it("passes custom headers via model spec", async () => {
      vi.mocked(completeSimple).mockResolvedValue(mockResponse("ALLOW"));

      const customHeaders = { "X-Custom": "value" };
      await callGuardian(
        makeParams({
          model: makeModel({ headers: customHeaders }),
        }),
      );

      const [model] = vi.mocked(completeSimple).mock.calls[0];
      expect(model.headers).toEqual(customHeaders);
    });
  });

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------
  describe("error handling", () => {
    it("returns fallback (allow) on completeSimple error", async () => {
      vi.mocked(completeSimple).mockRejectedValue(new Error("ECONNREFUSED"));

      const result = await callGuardian(makeParams());
      expect(result.action).toBe("allow");
      expect(result.reason).toContain("ECONNREFUSED");
    });

    it("returns fallback (block) when configured to block on error", async () => {
      vi.mocked(completeSimple).mockRejectedValue(new Error("ECONNREFUSED"));

      const result = await callGuardian(makeParams({ fallbackOnError: "block" }));
      expect(result.action).toBe("block");
    });

    it("returns fallback on empty response content", async () => {
      vi.mocked(completeSimple).mockResolvedValue(mockEmptyResponse());

      const result = await callGuardian(makeParams());
      expect(result.action).toBe("allow");
      expect(result.reason).toContain("not recognized");
    });

    it("extracts verdict from thinking blocks when no text blocks present", async () => {
      // Some reasoning models (e.g. kimi-coding) return thinking blocks only
      vi.mocked(completeSimple).mockResolvedValue({
        ...mockResponse(""),
        content: [{ type: "thinking", thinking: "ALLOW: user asked to run this command" }],
      } as AssistantMessage);

      const result = await callGuardian(makeParams());
      expect(result.action).toBe("allow");
      expect(result.reason).toContain("user asked to run this command");
    });

    it("prefers text blocks over thinking blocks", async () => {
      vi.mocked(completeSimple).mockResolvedValue({
        ...mockResponse(""),
        content: [
          { type: "thinking", thinking: "BLOCK: from thinking" },
          { type: "text", text: "ALLOW: user requested this" },
        ],
      } as AssistantMessage);

      const result = await callGuardian(makeParams());
      expect(result.action).toBe("allow"); // text block wins
    });

    it("returns fallback on unrecognized response format", async () => {
      vi.mocked(completeSimple).mockResolvedValue(mockResponse("I think this tool call is fine."));

      const result = await callGuardian(makeParams());
      expect(result.action).toBe("allow");
      expect(result.reason).toContain("not recognized");
    });

    it("handles timeout via abort signal", async () => {
      vi.mocked(completeSimple).mockImplementation(
        (_model, _ctx, opts) =>
          new Promise((_resolve, reject) => {
            opts?.signal?.addEventListener("abort", () => {
              reject(new Error("The operation was aborted"));
            });
          }),
      );

      const result = await callGuardian(makeParams({ timeoutMs: 50 }));
      expect(result.action).toBe("allow");
      expect(result.reason).toContain("timed out");
    });

    it("returns fallback when abort signal fires during response processing (race condition)", async () => {
      // Simulate the race: completeSimple resolves, but the abort signal
      // has already been triggered (e.g., timeout fires at the exact moment
      // the response arrives). The code checks controller.signal.aborted
      // after receiving the response.
      vi.mocked(completeSimple).mockImplementation((_model, _ctx, opts) => {
        // Abort the signal before returning, simulating the race
        const controller = (opts?.signal as AbortSignal & { _controller?: AbortController })
          ?._controller;
        // We can't access the controller directly, so we simulate by
        // returning a response and relying on the code's own abort check.
        // Instead, use a short timeout that fires during await.
        return new Promise((resolve) => {
          // Let the abort timer fire first by introducing a slight delay
          setTimeout(() => resolve(mockResponse("ALLOW: should be ignored")), 60);
        });
      });

      const result = await callGuardian(makeParams({ timeoutMs: 10, fallbackOnError: "block" }));
      // The abort fires before the response resolves, so it should be caught
      // either by the abort race guard or by the catch block
      expect(result.action).toBe("block");
      expect(result.reason).toContain("timed out");
    });

    it("returns fallback on response with only whitespace text", async () => {
      vi.mocked(completeSimple).mockResolvedValue(mockResponse("   \n  \n  "));

      const result = await callGuardian(makeParams());
      expect(result.action).toBe("allow");
      expect(result.reason).toContain("not recognized");
    });
  });

  // -----------------------------------------------------------------------
  // Debug logging
  // -----------------------------------------------------------------------
  describe("debug logging", () => {
    function makeTestLogger() {
      return {
        info: vi.fn(),
        warn: vi.fn(),
      };
    }

    it("logs request and response details when logger is provided", async () => {
      vi.mocked(completeSimple).mockResolvedValue(mockResponse("ALLOW"));

      const logger = makeTestLogger();
      await callGuardian(makeParams({ logger }));

      const infoMessages = logger.info.mock.calls.map((c: string[]) => c[0]);
      expect(infoMessages.some((m: string) => m.includes("Calling guardian LLM"))).toBe(true);
      expect(infoMessages.some((m: string) => m.includes("provider=test-provider"))).toBe(true);
      expect(infoMessages.some((m: string) => m.includes("model=test-model"))).toBe(true);
      // extractResponseText logs are internal; just check the main flow logged

      expect(infoMessages.some((m: string) => m.includes("Guardian responded in"))).toBe(true);
      expect(infoMessages.some((m: string) => m.includes("ALLOW"))).toBe(true);
    });

    it("logs prompt content (truncated) when logger is provided", async () => {
      vi.mocked(completeSimple).mockResolvedValue(mockResponse("BLOCK: suspicious"));

      const logger = makeTestLogger();
      await callGuardian(
        makeParams({
          userPrompt: "Check this tool call for alignment with user intent",
          logger,
        }),
      );

      const infoMessages = logger.info.mock.calls.map((c: string[]) => c[0]);
      expect(
        infoMessages.some((m: string) => m.includes("Prompt (user): Check this tool call")),
      ).toBe(true);
      expect(infoMessages.some((m: string) => m.includes("BLOCK"))).toBe(true);
    });

    it("logs warning on error when logger is provided", async () => {
      vi.mocked(completeSimple).mockRejectedValue(new Error("API rate limit exceeded"));

      const logger = makeTestLogger();
      await callGuardian(makeParams({ logger }));

      const warnMessages = logger.warn.mock.calls.map((c: string[]) => c[0]);
      expect(warnMessages.some((m: string) => m.includes("ERROR"))).toBe(true);
      expect(warnMessages.some((m: string) => m.includes("rate limit"))).toBe(true);
    });

    it("logs warning on timeout when logger is provided", async () => {
      vi.mocked(completeSimple).mockImplementation(
        (_model, _ctx, opts) =>
          new Promise((_resolve, reject) => {
            opts?.signal?.addEventListener("abort", () => {
              reject(new Error("The operation was aborted"));
            });
          }),
      );

      const logger = makeTestLogger();
      await callGuardian(makeParams({ timeoutMs: 50, logger }));

      const warnMessages = logger.warn.mock.calls.map((c: string[]) => c[0]);
      expect(warnMessages.some((m: string) => m.includes("TIMED OUT"))).toBe(true);
    });

    it("logs warning on empty response when logger is provided", async () => {
      vi.mocked(completeSimple).mockResolvedValue(mockEmptyResponse());

      const logger = makeTestLogger();
      await callGuardian(makeParams({ logger }));

      const warnMessages = logger.warn.mock.calls.map((c: string[]) => c[0]);
      expect(warnMessages.some((m: string) => m.includes("Empty response"))).toBe(true);
    });

    it("does not log when logger is not provided", async () => {
      vi.mocked(completeSimple).mockResolvedValue(mockResponse("ALLOW"));

      // No logger passed — should not throw
      const result = await callGuardian(makeParams());
      expect(result.action).toBe("allow");
    });
  });
});

// ---------------------------------------------------------------------------
// callForText tests
// ---------------------------------------------------------------------------

describe("guardian-client callForText", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeTextParams(overrides: Partial<TextCallParams> = {}): TextCallParams {
    return {
      model: makeModel(),
      systemPrompt: "summary system prompt",
      userPrompt: "summarize this conversation",
      timeoutMs: 20000,
      ...overrides,
    };
  }

  it("returns raw text from LLM response", async () => {
    vi.mocked(completeSimple).mockResolvedValue(mockResponse("User is deploying a web app"));

    const result = await callForText(makeTextParams());
    expect(result).toBe("User is deploying a web app");
  });

  it("passes maxTokens=200 (not 150 like callGuardian)", async () => {
    vi.mocked(completeSimple).mockResolvedValue(mockResponse("summary text"));

    await callForText(makeTextParams());

    const [, , options] = vi.mocked(completeSimple).mock.calls[0];
    expect(options?.maxTokens).toBe(200);
  });

  it("returns undefined on error", async () => {
    vi.mocked(completeSimple).mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await callForText(makeTextParams());
    expect(result).toBeUndefined();
  });

  it("returns undefined on timeout (abort race)", async () => {
    vi.mocked(completeSimple).mockImplementation(
      (_model, _ctx, opts) =>
        new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener("abort", () => {
            reject(new Error("The operation was aborted"));
          });
        }),
    );

    const result = await callForText(makeTextParams({ timeoutMs: 50 }));
    expect(result).toBeUndefined();
  });

  it("returns undefined on empty response", async () => {
    vi.mocked(completeSimple).mockResolvedValue(mockEmptyResponse());

    const result = await callForText(makeTextParams());
    expect(result).toBeUndefined();
  });

  it("passes system and user prompts correctly", async () => {
    vi.mocked(completeSimple).mockResolvedValue(mockResponse("result"));

    await callForText(
      makeTextParams({
        systemPrompt: "custom system",
        userPrompt: "custom user",
      }),
    );

    const [, context] = vi.mocked(completeSimple).mock.calls[0];
    expect(context.systemPrompt).toBe("custom system");
    expect(context.messages[0].content).toBe("custom user");
  });
});
