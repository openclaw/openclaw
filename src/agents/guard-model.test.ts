import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  applyGuardToPayloads,
  DEFAULT_GUARD_MAX_INPUT_CHARS,
  evaluateGuard,
  resolveGuardModelConfig,
  type GuardModelConfig,
  type ReplyPayload,
} from "./guard-model.js";

const TEST_PROVIDER = "guardtest";
const TEST_RUNTIME_CONFIG: OpenClawConfig = {
  models: {
    providers: {
      [TEST_PROVIDER]: {
        baseUrl: "https://guard.example/v1",
        apiKey: "test-key",
        models: [],
      },
    },
  },
};
const BASE_GUARD_CONFIG: GuardModelConfig = {
  provider: TEST_PROVIDER,
  modelId: "test-model",
  action: "block",
  onError: "allow",
};

function jsonGuardReply(content: string): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content } }],
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

function parseJsonRequestBody(init: RequestInit | undefined): {
  messages?: Array<{ role?: string; content?: string }>;
} {
  const body = init?.body;
  if (typeof body !== "string") {
    return {};
  }
  return JSON.parse(body) as {
    messages?: Array<{ role?: string; content?: string }>;
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("guard-model", () => {
  describe("resolveGuardModelConfig", () => {
    it("returns null if cfg is empty or missing guardModel", () => {
      expect(resolveGuardModelConfig(undefined)).toBeNull();
      expect(resolveGuardModelConfig({})).toBeNull();
      expect(resolveGuardModelConfig({ agents: { defaults: {} } })).toBeNull();
    });

    it("parses provider/model cleanly with defaults", () => {
      const cfg = {
        agents: {
          defaults: {
            guardModel: "chutes/Qwen/Qwen3Guard",
          },
        },
      };
      const res = resolveGuardModelConfig(cfg);
      expect(res).toEqual({
        provider: "chutes",
        modelId: "Qwen/Qwen3Guard",
        action: "block",
        onError: "allow",
      });
    });

    it("handles complex primary/fallbacks structure", () => {
      const cfg = {
        agents: {
          defaults: {
            guardModel: {
              primary: "openai/gpt-4o-mini",
              fallbacks: ["openai/gpt-4.1-mini"],
            },
            guardModelAction: "warn" as const,
            guardModelOnError: "block" as const,
            guardModelMaxInputChars: 64_000,
          },
        },
      };
      const res = resolveGuardModelConfig(cfg);
      expect(res).toEqual({
        provider: "openai",
        modelId: "gpt-4o-mini",
        fallbacks: [{ provider: "openai", modelId: "gpt-4.1-mini" }],
        action: "warn",
        onError: "block",
        maxInputChars: 64_000,
      });
    });

    it("returns null on malformed provider prefix", () => {
      const cfg = {
        agents: { defaults: { guardModel: "qwen-guard-no-provider" } },
      };
      const res = resolveGuardModelConfig(cfg);
      expect(res).toBeNull();
    });

    it("returns null when model id is empty", () => {
      const cfg = {
        agents: { defaults: { guardModel: "openai/" } },
      };
      const res = resolveGuardModelConfig(cfg);
      expect(res).toBeNull();
    });

    it("marks non-OpenAI-compatible guard providers as fail-closed", () => {
      const cfg: OpenClawConfig = {
        agents: { defaults: { guardModel: "anthropic/claude-opus-4-6" } },
      };
      const res = resolveGuardModelConfig(cfg);
      expect(res).toEqual(
        expect.objectContaining({
          provider: "anthropic",
          modelId: "claude-opus-4-6",
          onError: "block",
          compatibilityError: expect.stringContaining("not compatible"),
        }),
      );
    });
  });

  describe("applyGuardToPayloads", () => {
    it("short circuits if no text payloads exist to guard", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const payloads: ReplyPayload[] = [
        { isError: true, text: "Error" },
        { isReasoning: true, text: "Thinking" },
      ];
      const res = await applyGuardToPayloads(payloads, {
        provider: "chutes",
        modelId: "dummy",
        action: "block",
        onError: "allow",
      });
      expect(res).toEqual(payloads);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("blocks payloads when guard marks content unsafe", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        jsonGuardReply('{"safe":false,"reason":"violence","categories":["violence"]}'),
      );
      const payloads: ReplyPayload[] = [{ text: "unsafe text" }];

      const res = await applyGuardToPayloads(payloads, BASE_GUARD_CONFIG, {
        cfg: TEST_RUNTIME_CONFIG,
      });

      expect(res).toHaveLength(1);
      expect(res[0]?.isError).toBe(true);
      expect(res[0]?.text).toContain("blocked by the content safety guard");
      expect(res[0]?.text).toContain("violence");
    });

    it("annotates the last user-facing text when action is warn and content is unsafe", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        jsonGuardReply('{"safe":false,"reason":"self-harm","categories":["self-harm"]}'),
      );
      const payloads: ReplyPayload[] = [{ text: "original reply" }];

      const res = await applyGuardToPayloads(
        payloads,
        {
          ...BASE_GUARD_CONFIG,
          action: "warn",
        },
        { cfg: TEST_RUNTIME_CONFIG },
      );

      expect(res).toHaveLength(1);
      expect(res[0]?.isError).not.toBe(true);
      expect(res[0]?.text).toContain("original reply");
      expect(res[0]?.text).toContain("Content safety warning");
      expect(res[0]?.text).toContain("self-harm");
    });

    it("warn mode preserves trailing payload order for last-payload delivery", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        jsonGuardReply('{"safe":false,"reason":"policy","categories":["policy"]}'),
      );
      const payloads: ReplyPayload[] = [
        { text: "first reply" },
        { isError: true, text: "tool error details" },
        { text: "final reply" },
      ];

      const res = await applyGuardToPayloads(
        payloads,
        {
          ...BASE_GUARD_CONFIG,
          action: "warn",
        },
        { cfg: TEST_RUNTIME_CONFIG },
      );

      expect(res).toHaveLength(3);
      expect(res[0]?.text).toBe("first reply");
      expect(res[1]?.text).toBe("tool error details");
      expect(res[2]?.text).toContain("final reply");
      expect(res[2]?.text).toContain("Content safety warning");
      expect(res[2]?.text).toContain("policy");
    });

    it("forces block on guard API error when onError is block even if action is warn", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("upstream error", { status: 500 }),
      );
      const payloads: ReplyPayload[] = [{ text: "original reply" }];

      const res = await applyGuardToPayloads(
        payloads,
        {
          ...BASE_GUARD_CONFIG,
          action: "warn",
          onError: "block",
        },
        { cfg: TEST_RUNTIME_CONFIG },
      );

      expect(res).toHaveLength(1);
      expect(res[0]?.isError).toBe(true);
      expect(res[0]?.text).toContain("blocked because the content safety guard is unavailable");
      expect(res[0]?.text).toContain("content safety guard is unavailable");
      expect(res[0]?.text).not.toContain("Guard model error");
      expect(res[0]?.text).not.toContain("HTTP 500");
    });

    it("retries configured fallback models when the primary guard errors", async () => {
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response("upstream error", { status: 500 }))
        .mockResolvedValueOnce(
          jsonGuardReply('{"safe":false,"reason":"hate","categories":["hate"]}'),
        );
      const payloads: ReplyPayload[] = [{ text: "unsafe text" }];

      const res = await applyGuardToPayloads(
        payloads,
        {
          ...BASE_GUARD_CONFIG,
          fallbacks: [{ provider: TEST_PROVIDER, modelId: "fallback-model" }],
        },
        {
          cfg: TEST_RUNTIME_CONFIG,
        },
      );

      expect(res).toHaveLength(1);
      expect(res[0]?.isError).toBe(true);
      expect(res[0]?.text).toContain("blocked by the content safety guard");
      expect(res[0]?.text).toContain("hate");
    });

    it("caps oversized guard input with trailing [truncated] marker and annotates fail-open output", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementationOnce(async (_url, init) => {
        const request = parseJsonRequestBody(init);
        const userMessage =
          request.messages?.find((message) => message.role === "user")?.content ?? "";
        const guardContent = userMessage.split("Evaluate this assistant reply:\n\n")[1] ?? "";
        expect(guardContent.length).toBeLessThanOrEqual(64);
        expect(guardContent.endsWith("[truncated]")).toBe(true);
        return new Response("upstream error", { status: 500 });
      });
      const oversized = "A".repeat(320);
      const payloads: ReplyPayload[] = [{ text: oversized }];

      const res = await applyGuardToPayloads(
        payloads,
        {
          ...BASE_GUARD_CONFIG,
          onError: "allow",
          maxInputChars: 64,
        },
        { cfg: TEST_RUNTIME_CONFIG },
      );

      expect(res).toHaveLength(1);
      expect(res[0]?.isError).not.toBe(true);
      expect(res[0]?.text).toContain(oversized);
      expect(res[0]?.text).toContain("truncated to 64 characters");
    });

    it("keeps payload order/count stable when adding truncation warning", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonGuardReply('{"safe":true}'));
      const payloads: ReplyPayload[] = [{ text: "first" }, { text: "second" }];

      const res = await applyGuardToPayloads(
        payloads,
        {
          ...BASE_GUARD_CONFIG,
          onError: "allow",
          maxInputChars: 10,
        },
        { cfg: TEST_RUNTIME_CONFIG },
      );

      expect(res).toHaveLength(2);
      expect(res[0]?.text).toBe("first");
      expect(res[1]?.text).toContain("second");
      expect(res[1]?.text).toContain("truncated to 10 characters");
    });

    it("keeps fail-closed blocking behavior for oversized input when onError is block", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("upstream error", { status: 500 }),
      );
      const payloads: ReplyPayload[] = [{ text: "B".repeat(320) }];

      const res = await applyGuardToPayloads(
        payloads,
        {
          ...BASE_GUARD_CONFIG,
          onError: "block",
          maxInputChars: 64,
        },
        { cfg: TEST_RUNTIME_CONFIG },
      );

      expect(res).toHaveLength(1);
      expect(res[0]?.isError).toBe(true);
      expect(res[0]?.text).toContain("content safety guard is unavailable");
      expect(res[0]?.text).not.toContain("truncated to 64 characters");
    });
  });

  describe("base URL resolution", () => {
    it("uses base URL from explicit provider config for providers not in KNOWN_BASE_URLS", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementationOnce(async (url) => {
        const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
        expect(requestUrl).toContain("https://api.moonshot.ai/v1/chat/completions");
        return jsonGuardReply('{"safe":true}');
      });

      const cfg: OpenClawConfig = {
        models: {
          providers: {
            moonshot: {
              baseUrl: "https://api.moonshot.ai/v1",
              apiKey: "test-key",
              models: [],
            },
          },
        },
      };

      const res = await applyGuardToPayloads(
        [{ text: "assistant reply" }],
        { provider: "moonshot", modelId: "kimi-k2.5", action: "block", onError: "allow" },
        { cfg },
      );

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(res).toHaveLength(1);
      expect(res[0]?.isError).not.toBe(true);
    });

    it("matches provider key case-insensitively when resolving base URL", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementationOnce(async (url) => {
        const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
        expect(requestUrl).toContain("https://api.moonshot.ai/v1/chat/completions");
        return jsonGuardReply('{"safe":true}');
      });

      // Provider stored with mixed case; guard config uses lowercase
      const cfg: OpenClawConfig = {
        models: {
          providers: {
            Moonshot: {
              baseUrl: "https://api.moonshot.ai/v1",
              apiKey: "test-key",
              models: [],
            },
          },
        },
      };

      const res = await applyGuardToPayloads(
        [{ text: "assistant reply" }],
        { provider: "moonshot", modelId: "kimi-k2.5", action: "block", onError: "allow" },
        { cfg },
      );

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(res[0]?.isError).not.toBe(true);
    });
  });

  describe("evaluateGuard", () => {
    it("short-circuits as fail-closed for incompatible guard model config", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const res = await evaluateGuard("reply text", {
        ...BASE_GUARD_CONFIG,
        compatibilityError: 'API "anthropic-messages" is not OpenAI-compatible',
      });

      expect(res.safe).toBe(false);
      expect(res.source).toBe("error");
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("treats non-boolean safe field as guard error", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        jsonGuardReply('{"safe":"false","reason":"string not boolean"}'),
      );

      const res = await evaluateGuard("reply text", BASE_GUARD_CONFIG, {
        cfg: TEST_RUNTIME_CONFIG,
      });

      expect(res.safe).toBe(true);
      expect(res.source).toBe("error");
    });

    it("clears timeout when fetch rejects", async () => {
      vi.useFakeTimers();
      vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network down"));

      const res = await evaluateGuard("reply text", BASE_GUARD_CONFIG, {
        cfg: TEST_RUNTIME_CONFIG,
      });

      expect(res.safe).toBe(true);
      expect(res.source).toBe("error");
      expect(vi.getTimerCount()).toBe(0);
    });

    it("parses a verdict JSON object when response contains extra JSON blocks", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        jsonGuardReply('{"safe":false,"reason":"violence"}\n\ntrace: {"extra":"data"}'),
      );

      const res = await evaluateGuard("reply text", BASE_GUARD_CONFIG, {
        cfg: TEST_RUNTIME_CONFIG,
      });

      expect(res.safe).toBe(false);
      expect(res.reason).toBe("violence");
      expect(res.source).toBe("classification");
    });

    it("skips leading metadata JSON and parses the later verdict object", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        jsonGuardReply('{"trace":"abc123","latencyMs":42}\n{"safe":false,"reason":"policy"}'),
      );

      const res = await evaluateGuard("reply text", BASE_GUARD_CONFIG, {
        cfg: TEST_RUNTIME_CONFIG,
      });

      expect(res.safe).toBe(false);
      expect(res.reason).toBe("policy");
      expect(res.source).toBe("classification");
    });

    it("uses default max guard input chars when no override is configured", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementationOnce(async (_url, init) => {
        const request = parseJsonRequestBody(init);
        const userMessage =
          request.messages?.find((message) => message.role === "user")?.content ?? "";
        const guardContent = userMessage.split("Evaluate this assistant reply:\n\n")[1] ?? "";
        expect(guardContent.length).toBeLessThanOrEqual(DEFAULT_GUARD_MAX_INPUT_CHARS);
        return jsonGuardReply('{"safe":true}');
      });

      const res = await evaluateGuard(
        "C".repeat(DEFAULT_GUARD_MAX_INPUT_CHARS + 250),
        BASE_GUARD_CONFIG,
        {
          cfg: TEST_RUNTIME_CONFIG,
        },
      );

      expect(res.safe).toBe(true);
      expect(res.inputTruncated).toBe(true);
    });
  });
});
