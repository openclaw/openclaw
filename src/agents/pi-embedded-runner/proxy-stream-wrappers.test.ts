import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { createOpenRouterWrapper } from "./proxy-stream-wrappers.js";

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
});
