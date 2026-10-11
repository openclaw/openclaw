import { describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import type { OpenAICompletionsOptions } from "../provider-options.js";
import { streamOpenAICompletions } from "../providers/openai-completions.js";
import type { Context } from "../types.js";
import { isContextOverflow } from "../utils/overflow.js";
import { buildOpenAICompletionsParams } from "./openai-completions-params.js";
import { createOpenAICompletionsTransportStreamFn } from "./openai-completions-transport.js";
import { makeCompletionsChunk, makeCompletionsModel } from "./openai-completions.test-support.js";

async function runToolTurn(params: {
  remainingTokens: number;
  modelMaxTokens?: number;
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  tools?: boolean;
  supportsTools?: boolean;
  mode?: "managed" | "direct" | "native";
  options?: Pick<OpenAICompletionsOptions, "maxTokens" | "toolChoice">;
}) {
  const previousHost = getAiTransportHost();
  const maxTokensField = params.maxTokensField ?? "max_tokens";
  const options = { apiKey: "synthetic-test-key", ...params.options };
  const context: Context = {
    messages: [{ role: "user", content: "x".repeat(3_200), timestamp: 1 }],
    ...(params.tools === false
      ? {}
      : {
          tools: [
            {
              name: "count",
              description: "Increment the counter",
              parameters: { type: "object", properties: {} },
            },
          ],
        }),
  };
  const model = makeCompletionsModel({
    provider: params.mode === "native" ? "openai" : "compatible-proxy",
    baseUrl: params.mode === "native" ? "https://api.openai.com/v1" : "http://localhost:8000/v1",
    reasoning: false,
    maxTokens: params.modelMaxTokens ?? 4_096,
    contextWindow: 100_000,
    compat: { maxTokensField, supportsStrictMode: false, supportsTools: params.supportsTools },
  });
  // Shape only the tool fixture at an unconstrained budget; the expected output
  // floors below are independent, fixed values rather than a production result.
  const prepared = buildOpenAICompletionsParams(model, context, options);
  const toolChars = prepared.tools?.length ? JSON.stringify(prepared.tools).length : 0;
  const estimatedInputTokens = Math.ceil(((3_200 + toolChars) / 4) * 1.25);
  model.contextTokens = estimatedInputTokens + params.remainingTokens + 1;
  let request: Record<string, unknown> | undefined;
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    request = JSON.parse(await new Request(input, init).text());
    return new Response(
      `data: ${JSON.stringify(makeCompletionsChunk({ content: "OK" }, "stop"))}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  configureAiTransportHost({ ...previousHost, buildModelFetch: () => fetch });
  try {
    const stream = await (params.mode === "direct"
      ? streamOpenAICompletions(model, context, options)
      : createOpenAICompletionsTransportStreamFn()(model, context, options));
    for await (const event of stream) {
      void event;
    }
    return { result: await stream.result(), request, fetch, contextTokens: model.contextTokens };
  } finally {
    configureAiTransportHost(previousHost);
  }
}

describe("compatible tool output admission", () => {
  it.each([
    [64, 16, "max_tokens"],
    [256, 32, "max_completion_tokens"],
    [4_096, 512, "max_tokens"],
    [32_768, 2_048, "max_completion_tokens"],
  ] as const)(
    "admits a model with %i output capacity at %i tokens",
    async (modelMaxTokens, floor, maxTokensField) => {
      const rejected = await runToolTurn({
        modelMaxTokens,
        maxTokensField,
        remainingTokens: floor - 1,
      });
      expect(rejected.fetch).not.toHaveBeenCalled();
      expect(rejected.result.stopReason).toBe("error");
      expect(isContextOverflow(rejected.result, rejected.contextTokens)).toBe(true);

      const accepted = await runToolTurn({
        modelMaxTokens,
        maxTokensField,
        remainingTokens: floor,
      });
      expect(accepted.fetch).toHaveBeenCalledTimes(1);
      expect(accepted.request?.[maxTokensField]).toBe(floor);
      expect(accepted.result.stopReason).toBe("stop");
      expect(accepted.result.content).toContainEqual(
        expect.objectContaining({ type: "text", text: "OK" }),
      );
    },
  );

  it.each([1, 15, 128])(
    "honors an explicit %i-token tool budget when it fits",
    async (maxTokens) => {
      const { result, request, fetch } = await runToolTurn({
        remainingTokens: maxTokens,
        options: { maxTokens },
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(request?.max_tokens).toBe(maxTokens);
      expect(result.stopReason).toBe("stop");
    },
  );

  it.each([
    { name: "no tools", tools: false },
    { name: "a route without tool support", supportsTools: false },
    { name: "tool choice none", options: { toolChoice: "none" as const } },
  ])("preserves the 16-token floor with $name", async ({ name: _name, ...params }) => {
    const { result, request, fetch } = await runToolTurn({ ...params, remainingTokens: 16 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(request?.max_tokens).toBe(16);
    expect(result.stopReason).toBe("stop");
  });

  it.each(["native", "direct"] as const)(
    "leaves %s provider output budgets unchanged",
    async (mode) => {
      const { result, request, fetch } = await runToolTurn({
        mode,
        remainingTokens: 16,
        options: { maxTokens: 4_096 },
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(request?.max_tokens).toBe(4_096);
      expect(result.stopReason).toBe("stop");
    },
  );
});
