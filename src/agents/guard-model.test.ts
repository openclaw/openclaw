import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  applyGuardToPayloads,
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

    it("appends warning when action is warn and content is unsafe", async () => {
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

      expect(res).toHaveLength(2);
      expect(res[0]?.text).toBe("original reply");
      expect(res[1]?.isError).toBe(true);
      expect(res[1]?.text).toContain("Content safety warning");
      expect(res[1]?.text).toContain("self-harm");
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
  });

  describe("evaluateGuard", () => {
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

    it("parses the first JSON object when response contains extra brace blocks", async () => {
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
  });
});
