import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { callGuardian } from "./guardian-client.js";
import type { GuardianCallParams } from "./guardian-client.js";
import type { ResolvedGuardianModel } from "./types.js";

// Default test model (OpenAI-compatible)
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

// Default call params
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

describe("guardian-client", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("OpenAI-compatible API", () => {
    it("returns ALLOW when guardian says ALLOW", async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: "ALLOW" } }] }), {
          status: 200,
        }),
      );

      const result = await callGuardian(makeParams());
      expect(result.action).toBe("allow");
    });

    it("returns BLOCK with reason when guardian says BLOCK", async () => {
      fetchSpy.mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "BLOCK: user never asked to send a message" } }],
          }),
          { status: 200 },
        ),
      );

      const result = await callGuardian(makeParams());
      expect(result.action).toBe("block");
      expect(result.reason).toBe("user never asked to send a message");
    });

    it("handles BLOCK without colon separator", async () => {
      fetchSpy.mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "BLOCK suspicious tool call" } }],
          }),
          { status: 200 },
        ),
      );

      const result = await callGuardian(makeParams());
      expect(result.action).toBe("block");
    });

    it("sends correct request body with model info", async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: "ALLOW" } }] }), {
          status: 200,
        }),
      );

      await callGuardian(
        makeParams({
          systemPrompt: "test system",
          userPrompt: "test user",
        }),
      );

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, options] = fetchSpy.mock.calls[0] as [string, RequestInit];

      expect(url).toBe("https://api.example.com/v1/chat/completions");
      expect(options.method).toBe("POST");

      const headers = options.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer test-key");
      expect(headers["Content-Type"]).toBe("application/json");

      const body = JSON.parse(options.body as string);
      expect(body.model).toBe("test-model");
      expect(body.messages).toEqual([
        { role: "system", content: "test system" },
        { role: "user", content: "test user" },
      ]);
      expect(body.max_tokens).toBe(150);
      expect(body.temperature).toBe(0);
    });

    it("omits Authorization header when no apiKey", async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: "ALLOW" } }] }), {
          status: 200,
        }),
      );

      await callGuardian(
        makeParams({
          model: makeModel({ apiKey: undefined }),
        }),
      );

      const [, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const headers = options.headers as Record<string, string>;
      expect(headers.Authorization).toBeUndefined();
    });

    it("strips trailing slashes from baseUrl", async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: "ALLOW" } }] }), {
          status: 200,
        }),
      );

      await callGuardian(
        makeParams({
          model: makeModel({ baseUrl: "https://api.example.com/v1///" }),
        }),
      );

      const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.example.com/v1/chat/completions");
    });

    it("handles case-insensitive ALLOW/BLOCK", async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: "allow" } }] }), {
          status: 200,
        }),
      );

      const result = await callGuardian(makeParams());
      expect(result.action).toBe("allow");
    });
  });

  describe("Anthropic Messages API", () => {
    it("calls Anthropic endpoint with correct format", async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ content: [{ type: "text", text: "ALLOW" }] }), {
          status: 200,
        }),
      );

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

      const [url, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.anthropic.com/v1/messages");

      const headers = options.headers as Record<string, string>;
      expect(headers["x-api-key"]).toBe("ant-key");
      expect(headers["anthropic-version"]).toBe("2023-06-01");

      const body = JSON.parse(options.body as string);
      expect(body.system).toBe("system prompt");
      expect(body.messages).toEqual([{ role: "user", content: "user prompt" }]);
    });

    it("returns BLOCK from Anthropic response", async () => {
      fetchSpy.mockResolvedValue(
        new Response(
          JSON.stringify({ content: [{ type: "text", text: "BLOCK: not requested" }] }),
          { status: 200 },
        ),
      );

      const result = await callGuardian(
        makeParams({
          model: makeModel({ api: "anthropic-messages" }),
        }),
      );

      expect(result.action).toBe("block");
      expect(result.reason).toBe("not requested");
    });
  });

  describe("Google Generative AI (Gemini) API", () => {
    it("calls Gemini endpoint with correct format", async () => {
      fetchSpy.mockResolvedValue(
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: "ALLOW" }] } }],
          }),
          { status: 200 },
        ),
      );

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

      expect(result.action).toBe("allow");

      const [url, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent",
      );

      const headers = options.headers as Record<string, string>;
      expect(headers["x-goog-api-key"]).toBe("google-key");

      const body = JSON.parse(options.body as string);
      expect(body.systemInstruction.parts[0].text).toBe("system prompt");
      expect(body.contents[0].role).toBe("user");
      expect(body.contents[0].parts[0].text).toBe("user prompt");
      expect(body.generationConfig.maxOutputTokens).toBe(150);
      expect(body.generationConfig.temperature).toBe(0);
    });

    it("returns BLOCK from Gemini response", async () => {
      fetchSpy.mockResolvedValue(
        new Response(
          JSON.stringify({
            candidates: [
              { content: { parts: [{ text: "BLOCK: user never asked to send a message" }] } },
            ],
          }),
          { status: 200 },
        ),
      );

      const result = await callGuardian(
        makeParams({
          model: makeModel({ api: "google-generative-ai" }),
        }),
      );

      expect(result.action).toBe("block");
      expect(result.reason).toBe("user never asked to send a message");
    });

    it("returns fallback on Gemini HTTP error", async () => {
      fetchSpy.mockResolvedValue(new Response("Not Found", { status: 404 }));

      const result = await callGuardian(
        makeParams({
          model: makeModel({ api: "google-generative-ai" }),
        }),
      );

      expect(result.action).toBe("allow");
      expect(result.reason).toContain("HTTP 404");
    });

    it("returns fallback on empty Gemini response", async () => {
      fetchSpy.mockResolvedValue(new Response(JSON.stringify({ candidates: [] }), { status: 200 }));

      const result = await callGuardian(
        makeParams({
          model: makeModel({ api: "google-generative-ai" }),
        }),
      );

      expect(result.action).toBe("allow");
      expect(result.reason).toContain("empty response");
    });
  });

  describe("error handling", () => {
    it("returns fallback (allow) on HTTP error", async () => {
      fetchSpy.mockResolvedValue(new Response("Internal Server Error", { status: 500 }));

      const result = await callGuardian(makeParams());
      expect(result.action).toBe("allow");
      expect(result.reason).toContain("HTTP 500");
    });

    it("returns fallback (block) when configured to block on error", async () => {
      fetchSpy.mockResolvedValue(new Response("Internal Server Error", { status: 500 }));

      const result = await callGuardian(makeParams({ fallbackOnError: "block" }));
      expect(result.action).toBe("block");
    });

    it("returns fallback on network error", async () => {
      fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));

      const result = await callGuardian(makeParams());
      expect(result.action).toBe("allow");
      expect(result.reason).toContain("ECONNREFUSED");
    });

    it("returns fallback on empty response content", async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), { status: 200 }),
      );

      const result = await callGuardian(makeParams());
      expect(result.action).toBe("allow");
      expect(result.reason).toContain("empty response");
    });

    it("returns fallback on unrecognized response format", async () => {
      fetchSpy.mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "I think this tool call is fine." } }],
          }),
          { status: 200 },
        ),
      );

      const result = await callGuardian(makeParams());
      expect(result.action).toBe("allow");
      expect(result.reason).toContain("not recognized");
    });

    it("handles timeout via abort signal", async () => {
      fetchSpy.mockImplementation(
        (_url: string | URL | Request, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            const signal = init?.signal;
            if (signal) {
              signal.addEventListener("abort", () => {
                reject(new Error("The operation was aborted"));
              });
            } else {
              setTimeout(() => reject(new Error("The operation was aborted")), 200);
            }
          }),
      );

      const result = await callGuardian(makeParams({ timeoutMs: 50 }));
      expect(result.action).toBe("allow");
      expect(result.reason).toContain("timed out");
    });
  });

  describe("debug logging", () => {
    function makeTestLogger() {
      return {
        info: vi.fn(),
        warn: vi.fn(),
      };
    }

    it("logs request and response details when logger is provided", async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: "ALLOW" } }] }), {
          status: 200,
        }),
      );

      const logger = makeTestLogger();

      await callGuardian(makeParams({ logger }));

      // Should log: request details, request URL, raw response, final response
      const infoMessages = logger.info.mock.calls.map((c: string[]) => c[0]);
      expect(infoMessages.some((m: string) => m.includes("Calling guardian LLM"))).toBe(true);
      expect(infoMessages.some((m: string) => m.includes("provider=test-provider"))).toBe(true);
      expect(infoMessages.some((m: string) => m.includes("model=test-model"))).toBe(true);
      expect(infoMessages.some((m: string) => m.includes("Request URL"))).toBe(true);
      expect(infoMessages.some((m: string) => m.includes("Raw response content"))).toBe(true);
      expect(infoMessages.some((m: string) => m.includes("Guardian responded in"))).toBe(true);
      expect(infoMessages.some((m: string) => m.includes("ALLOW"))).toBe(true);
    });

    it("logs prompt content (truncated) when logger is provided", async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: "BLOCK: suspicious" } }] }), {
          status: 200,
        }),
      );

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

    it("logs warning on HTTP error when logger is provided", async () => {
      fetchSpy.mockResolvedValue(new Response("Internal Server Error", { status: 500 }));

      const logger = makeTestLogger();

      await callGuardian(makeParams({ logger }));

      const warnMessages = logger.warn.mock.calls.map((c: string[]) => c[0]);
      expect(warnMessages.some((m: string) => m.includes("HTTP error"))).toBe(true);
      expect(warnMessages.some((m: string) => m.includes("500"))).toBe(true);
    });

    it("logs warning on timeout when logger is provided", async () => {
      fetchSpy.mockImplementation(
        (_url: string | URL | Request, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            const signal = init?.signal;
            if (signal) {
              signal.addEventListener("abort", () => {
                reject(new Error("The operation was aborted"));
              });
            }
          }),
      );

      const logger = makeTestLogger();

      await callGuardian(makeParams({ timeoutMs: 50, logger }));

      const warnMessages = logger.warn.mock.calls.map((c: string[]) => c[0]);
      expect(warnMessages.some((m: string) => m.includes("TIMED OUT"))).toBe(true);
    });

    it("does not log when logger is not provided", async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: "ALLOW" } }] }), {
          status: 200,
        }),
      );

      // No logger passed — should not throw
      const result = await callGuardian(makeParams());
      expect(result.action).toBe("allow");
    });

    it("logs Anthropic request details when logger is provided", async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ content: [{ type: "text", text: "ALLOW" }] }), {
          status: 200,
        }),
      );

      const logger = makeTestLogger();

      await callGuardian(
        makeParams({
          model: makeModel({
            api: "anthropic-messages",
            baseUrl: "https://api.anthropic.com",
            apiKey: "ant-key",
          }),
          logger,
        }),
      );

      const infoMessages = logger.info.mock.calls.map((c: string[]) => c[0]);
      expect(infoMessages.some((m: string) => m.includes("api=anthropic-messages"))).toBe(true);
      expect(infoMessages.some((m: string) => m.includes("Request URL"))).toBe(true);
      expect(infoMessages.some((m: string) => m.includes("Raw response content"))).toBe(true);
    });
  });
});
