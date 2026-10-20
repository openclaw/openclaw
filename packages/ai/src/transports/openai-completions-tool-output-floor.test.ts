import { describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import type { OpenAICompletionsOptions } from "../provider-options.js";
import { streamOpenAICompletions } from "../providers/openai-completions.js";
import type { Context } from "../types.js";
import { isContextOverflow } from "../utils/overflow.js";
import { buildOpenAICompletionsParams } from "./openai-completions-params.js";
import { createOpenAICompletionsTransportStreamFn } from "./openai-completions-transport.js";
import { makeCompletionsChunk, makeCompletionsModel } from "./openai-completions.test-support.js";

function makeTools(): Context["tools"] {
  return [
    {
      name: "count",
      description: "Increment the counter",
      parameters: { type: "object", properties: {} },
    },
  ];
}

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
    tools: params.tools === false ? undefined : makeTools(),
  };
  const model = {
    ...makeCompletionsModel({
      provider: params.mode === "native" ? "openai" : "compatible-proxy",
      baseUrl: params.mode === "native" ? "https://api.openai.com/v1" : "http://localhost:8000/v1",
      reasoning: false,
      maxTokens: params.modelMaxTokens ?? 4_096,
      contextWindow: 100_000,
    }),
    compat: { maxTokensField, supportsStrictMode: false, supportsTools: params.supportsTools },
  };
  // Measure only the tool fixture; expected output floors below are fixed independently.
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

async function expectAccepted(
  tokens: number,
  params: Partial<Parameters<typeof runToolTurn>[0]> = {},
) {
  const { result, request, fetch } = await runToolTurn({ remainingTokens: tokens, ...params });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(request?.[params.maxTokensField ?? "max_tokens"]).toBe(tokens);
  expect(result.stopReason).toBe("stop");
  expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "OK" }));
}

describe("compatible tool output admission", () => {
  it.each([
    [64, 16, "max_tokens"],
    [256, 32, "max_completion_tokens"],
    [4_096, 512, "max_tokens"],
    [32_768, 2_048, "max_completion_tokens"],
  ] as const)(
    "admits %i-token models at floor %i (%s)",
    async (modelMaxTokens, floor, maxTokensField) => {
      const rejected = await runToolTurn({
        modelMaxTokens,
        maxTokensField,
        remainingTokens: floor - 1,
      });
      expect(rejected.fetch).not.toHaveBeenCalled();
      expect(rejected.result.stopReason).toBe("error");
      expect(isContextOverflow(rejected.result, rejected.contextTokens)).toBe(true);

      await expectAccepted(floor, { modelMaxTokens, maxTokensField });
    },
  );

  it.each([1, 15, 128])("honors explicit %i-token tool budgets", async (maxTokens) => {
    await expectAccepted(maxTokens, { options: { maxTokens } });
  });

  it.each([
    { name: "no tools", tools: false },
    { name: "a route without tool support", supportsTools: false },
    { name: "tool choice none", options: { toolChoice: "none" as const } },
  ])("preserves the 16-token floor with $name", async ({ name: _name, ...params }) => {
    await expectAccepted(16, params);
  });

  it.each(["native", "direct"] as const)("preserves %s provider output budgets", async (mode) => {
    await expectAccepted(4_096, { mode, remainingTokens: 16, options: { maxTokens: 4_096 } });
  });
});
