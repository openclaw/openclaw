import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { createKilocodeWrapper, createOpenRouterWrapper } from "./proxy-stream-wrappers.js";

const OR_MODEL = {
  api: "openai-completions",
  provider: "openrouter",
  id: "openrouter/auto",
} as Model<"openai-completions">;

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

  describe("reasoning payload normalization (thinking=off)", () => {
    it("strips reasoning object when thinkingLevel is off (OpenRouter)", () => {
      const payloads: Array<Record<string, unknown>> = [];
      const base: StreamFn = (_m, _c, opts) => {
        const p: Record<string, unknown> = {
          reasoning: { effort: "none" },
          reasoning_effort: "none",
          messages: [],
        };
        opts?.onPayload?.(p, _m);
        payloads.push(p);
        return createAssistantMessageEventStream();
      };

      const wrapped = createOpenRouterWrapper(base, "off");
      void wrapped(OR_MODEL, { messages: [] }, undefined);

      expect(payloads[0]).not.toHaveProperty("reasoning");
      expect(payloads[0]).not.toHaveProperty("reasoning_effort");
    });

    it("strips reasoning object when thinkingLevel is off (Kilocode)", () => {
      const payloads: Array<Record<string, unknown>> = [];
      const base: StreamFn = (_m, _c, opts) => {
        const p: Record<string, unknown> = {
          reasoning: { effort: "none" },
          reasoning_effort: "none",
          messages: [],
        };
        opts?.onPayload?.(p, _m);
        payloads.push(p);
        return createAssistantMessageEventStream();
      };

      const wrapped = createKilocodeWrapper(base, "off");
      void wrapped(OR_MODEL, { messages: [] }, undefined);

      expect(payloads[0]).not.toHaveProperty("reasoning");
      expect(payloads[0]).not.toHaveProperty("reasoning_effort");
    });

    it("strips reasoning object when thinkingLevel is undefined", () => {
      const payloads: Array<Record<string, unknown>> = [];
      const base: StreamFn = (_m, _c, opts) => {
        const p: Record<string, unknown> = {
          reasoning: { effort: "none" },
          messages: [],
        };
        opts?.onPayload?.(p, _m);
        payloads.push(p);
        return createAssistantMessageEventStream();
      };

      const wrapped = createOpenRouterWrapper(base, undefined);
      void wrapped(OR_MODEL, { messages: [] }, undefined);

      expect(payloads[0]).not.toHaveProperty("reasoning");
    });

    it("preserves reasoning object when thinkingLevel is high", () => {
      const payloads: Array<Record<string, unknown>> = [];
      const base: StreamFn = (_m, _c, opts) => {
        const p: Record<string, unknown> = {
          reasoning: { effort: "none" },
          messages: [],
        };
        opts?.onPayload?.(p, _m);
        payloads.push(p);
        return createAssistantMessageEventStream();
      };

      const wrapped = createOpenRouterWrapper(base, "high");
      void wrapped(OR_MODEL, { messages: [] }, undefined);

      // Existing reasoning with effort should be preserved (not overwritten
      // because it already has an effort key).
      expect(payloads[0]).toHaveProperty("reasoning");
    });
  });
});
