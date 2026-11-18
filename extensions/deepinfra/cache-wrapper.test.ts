import { createOpenAICompletionsTransportStreamFn } from "@openclaw/ai/transports";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import {
  createAssistantMessageEventStream,
  streamSimple,
  type Model,
} from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import deepinfraPlugin from "./index.js";

const NEMOTRON = "nvidia/NVIDIA-Nemotron-3.5-Super-VL";
const ANTHROPIC = "anthropic/claude-sonnet-4-6";
const DEEPSEEK = "deepseek-ai/DeepSeek-V4-Flash";
afterEach(() => vi.unstubAllGlobals());

function makeModel(id: string): Model<"openai-completions"> {
  return {
    api: "openai-completions",
    id,
    provider: "deepinfra",
    name: "Synthetic model",
    baseUrl: "https://api.deepinfra.com/v1/openai",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 8192,
  };
}

const conversation = (content: unknown, user: unknown = "Hi") => ({
  messages: [
    { role: "system", content },
    { role: "user", content: user },
  ],
});
const cachedText = (text: string) => ({
  type: "text",
  text,
  cache_control: { type: "ephemeral" },
});

async function registeredWrapper(
  base: StreamFn,
  modelId: string,
  cacheRetention?: string,
  thinkingLevel?: "off" | "high",
) {
  const provider = await registerSingleProviderPlugin(deepinfraPlugin);
  return (
    provider.wrapStreamFn?.({
      provider: "deepinfra",
      modelId,
      streamFn: base,
      thinkingLevel,
      extraParams: { cacheRetention },
    }) ?? expect.fail("DeepInfra stream wrapper missing")
  );
}

describe("registered DeepInfra request wrapper", () => {
  const system = conversation("system");
  const tagged = conversation([cachedText("system")], [cachedText("Hi")]);
  const blocks = [
    { type: "text", text: "Block one" },
    { type: "text", text: "Block two" },
  ];
  const native = {
    system: [cachedText("system")],
    messages: [{ role: "user", content: [{ type: "text", text: "question" }] }],
  };
  it.each([
    ["Anthropic/Claude-Sonnet-4-6", undefined, undefined, system, tagged, "short"],
    [
      "anthropic/claude-haiku-4-5",
      undefined,
      undefined,
      conversation(blocks),
      conversation([blocks[0], cachedText("Block two")], [cachedText("Hi")]),
      "short",
    ],
    [ANTHROPIC, undefined, "none", system, system, "none"],
    [ANTHROPIC, undefined, "long", system, tagged, "long"],
    [ANTHROPIC, "anthropic-messages", "long", native, native, undefined],
    [DEEPSEEK, undefined, undefined, conversation("sys"), conversation("sys"), undefined],
  ] as const)(
    "preserves cache and API policy for %s",
    async (modelId, api, cacheRetention, input, expected, option) => {
      let captured: Record<string, unknown> = {};
      const base = vi.fn<StreamFn>((model, _context, options) => {
        const payload = structuredClone(input);
        options?.onPayload?.(payload, model);
        captured = payload;
        return createAssistantMessageEventStream();
      });
      const wrapped = await registeredWrapper(base, modelId, cacheRetention);
      void wrapped(
        { ...makeModel(modelId), api: api ?? "openai-completions" },
        { messages: [] },
        {},
      );
      expect(base).toHaveBeenCalledOnce();
      expect(captured).toEqual(expected);
      expect(JSON.stringify(captured)).not.toContain('"ttl"');
      expect(base.mock.calls[0]?.[2]?.cacheRetention).toBe(option);
    },
  );

  it.each([
    [ANTHROPIC, undefined, "none", false, undefined, undefined, undefined, false],
    [ANTHROPIC, undefined, "short", true, undefined, undefined, undefined, false],
    [NEMOTRON, "off", undefined, false, undefined, { enabled: false }, undefined, false],
    [NEMOTRON, "high", undefined, false, undefined, { effort: "high" }, undefined, false],
    [NEMOTRON, undefined, undefined, false, undefined, undefined, undefined, false],
    [DEEPSEEK, "off", undefined, false, "deepseek", undefined, { type: "disabled" }, false],
    [ANTHROPIC, "off", undefined, false, undefined, undefined, undefined, true],
    ["zai-org/GLM-5.3", "off", undefined, false, undefined, undefined, undefined, false],
  ] as const)("serializes managed reasoning and cache policy for %s", async (...row) => {
    const [id, level, retention, stringOnly, format, reasoning, thinking, cache] = row;
    const model: Model<"openai-completions"> & { compat: { requiresStringContent: boolean } } = {
      ...makeModel(id),
      reasoning: true,
      compat: { requiresStringContent: stringOnly, thinkingFormat: format },
    };
    let payload: Record<string, unknown> = {};
    const capture = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe("https://api.deepinfra.com/v1/openai/chat/completions");
      payload = JSON.parse(await request.text());
      return new Response(
        'data: {"id":"capture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"Synthetic response"},"finish_reason":null}]}\n\ndata: {"id":"capture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { "Content-Type": "text/event-stream" } },
      );
    });
    vi.stubGlobal("fetch", capture);
    // String-only content is a managed transport contract.
    const base = stringOnly ? createOpenAICompletionsTransportStreamFn() : streamSimple;
    const wrapped = await registeredWrapper(base, id, retention, level);
    const stream = await wrapped(
      model,
      {
        systemPrompt: "STABLE",
        messages: [{ role: "user", content: "Question", timestamp: 1 }],
      },
      { apiKey: "synthetic-local-only", reasoning: level },
    );
    expect((await stream.result()).stopReason).toBe("stop");
    expect(capture).toHaveBeenCalledOnce();
    expect(payload.reasoning).toEqual(reasoning);
    expect(payload.thinking).toEqual(thinking);
    expect(payload).not.toHaveProperty("reasoning_effort");
    expect(JSON.stringify(payload).includes('"cache_control"')).toBe(cache);
    if (!cache) {
      expect(payload.messages).toEqual(conversation("STABLE", "Question").messages);
    }
  });
});
