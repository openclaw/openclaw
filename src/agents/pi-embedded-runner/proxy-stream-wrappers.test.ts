import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { createDeepInfraWrapper, createOpenRouterWrapper } from "./proxy-stream-wrappers.js";

describe("proxy stream wrappers", () => {
  it("adds OpenRouter attribution headers to stream options", () => {
    const calls: Array<{ headers?: Record<string, string> }> = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      calls.push({
        headers: options?.headers,
      });
      return createAssistantMessageEventStream();
    };

    const wrapped = createOpenRouterWrapper(baseStreamFn);
    const model = {
      api: "openai-completions",
      provider: "openrouter",
      id: "openrouter/auto",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };

    void wrapped(model, context, { headers: { "X-Custom": "1" } });

    expect(calls).toEqual([
      {
        headers: {
          "HTTP-Referer": "https://openclaw.ai",
          "X-OpenRouter-Title": "OpenClaw",
          "X-OpenRouter-Categories": "cli-agent",
          "X-Custom": "1",
        },
      },
    ]);
  });

  describe("createDeepInfraWrapper", () => {
    function capturePayloads() {
      const payloads: unknown[] = [];
      const baseStreamFn: StreamFn = (_model, _context, options) => {
        const payload = { model: "test" };
        options?.onPayload?.(payload, _model);
        payloads.push(structuredClone(payload));
        return createAssistantMessageEventStream();
      };
      return { baseStreamFn, payloads };
    }

    const model = {
      api: "openai-completions",
      provider: "deepinfra",
      id: "moonshotai/Kimi-K2.5",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };

    it("injects reasoning effort when thinkingLevel is set", () => {
      const { baseStreamFn, payloads } = capturePayloads();
      const wrapped = createDeepInfraWrapper(baseStreamFn, "high");
      void wrapped(model, context, {});

      expect(payloads[0]).toEqual({
        model: "test",
        reasoning: { effort: "high" },
      });
    });

    it("maps 'off' to no reasoning field", () => {
      const { baseStreamFn, payloads } = capturePayloads();
      const wrapped = createDeepInfraWrapper(baseStreamFn, "off");
      void wrapped(model, context, {});

      expect(payloads[0]).toEqual({ model: "test" });
    });

    it("does not inject reasoning when thinkingLevel is undefined", () => {
      const { baseStreamFn, payloads } = capturePayloads();
      const wrapped = createDeepInfraWrapper(baseStreamFn, undefined);
      void wrapped(model, context, {});

      expect(payloads[0]).toEqual({ model: "test" });
    });

    it("preserves existing onPayload callback", () => {
      const { baseStreamFn } = capturePayloads();
      const wrapped = createDeepInfraWrapper(baseStreamFn, "low");
      const seen: unknown[] = [];
      void wrapped(model, context, {
        onPayload: (payload) => {
          seen.push(structuredClone(payload));
        },
      });

      expect(seen[0]).toEqual({
        model: "test",
        reasoning: { effort: "low" },
      });
    });
  });
});
