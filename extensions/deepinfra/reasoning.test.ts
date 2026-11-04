import { streamSimple, type Model } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import deepinfraPlugin from "./index.js";

const NEMOTRON = "nvidia/NVIDIA-Nemotron-3.5-Super-VL";

afterEach(() => vi.unstubAllGlobals());

async function captureRequest(
  thinkingLevel?: "off" | "high",
  modelId = NEMOTRON,
  compat?: Model<"openai-completions">["compat"],
) {
  const requests: { url: string; payload: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push({ url: request.url, payload: JSON.parse(await request.text()) });
      return new Response(
        'data: {"id":"local-capture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"Synthetic response"},"finish_reason":null}]}\n\ndata: {"id":"local-capture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }),
  );
  const model: Model<"openai-completions"> = {
    api: "openai-completions",
    id: modelId,
    provider: "deepinfra",
    name: "Synthetic reasoning-capable catalog row",
    baseUrl: "https://api.deepinfra.com/v1/openai",
    reasoning: true,
    compat,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 8192,
  };
  const provider = await registerSingleProviderPlugin(deepinfraPlugin);
  const wrapped = provider.wrapStreamFn?.({
    provider: "deepinfra",
    modelId,
    thinkingLevel,
    streamFn: streamSimple,
  });
  if (!wrapped) {
    throw new Error("DeepInfra stream wrapper missing");
  }
  const stream = await wrapped(
    model,
    {
      messages: [{ role: "user", content: "Local transport capture", timestamp: 0 }],
    },
    { apiKey: "synthetic-local-only", reasoning: thinkingLevel },
  );
  const result = await stream.result();
  expect(result.stopReason).toBe("stop");
  expect(requests).toHaveLength(1);
  const request = requests[0];
  if (!request) {
    throw new Error("Missing serialized DeepInfra request");
  }
  expect(request.url).toBe("https://api.deepinfra.com/v1/openai/chat/completions");
  return request.payload;
}

describe("registered DeepInfra reasoning request", () => {
  it("explicitly disables default-on Nemotron reasoning in the serialized request", async () => {
    const payload = await captureRequest("off");
    expect(payload.reasoning).toEqual({ enabled: false });
    expect(payload).not.toHaveProperty("reasoning_effort");
  });

  it("preserves enabled nested reasoning effort", async () => {
    const payload = await captureRequest("high");
    expect(payload.reasoning).toEqual({ effort: "high" });
    expect(payload).not.toHaveProperty("reasoning_effort");
  });

  it("leaves unset thinking at the provider default", async () => {
    const payload = await captureRequest();
    expect(payload).not.toHaveProperty("reasoning");
    expect(payload).not.toHaveProperty("reasoning_effort");
  });

  it("preserves the DeepSeek binary thinking dialect", async () => {
    const payload = await captureRequest("off", "deepseek-ai/DeepSeek-V4-Flash", {
      thinkingFormat: "deepseek",
    });
    expect(payload.thinking).toEqual({ type: "disabled" });
    expect(payload).not.toHaveProperty("reasoning");
  });

  it("preserves Anthropic cache markers without adding a reasoning selector", async () => {
    const payload = await captureRequest("off", "anthropic/claude-sonnet-4-6");
    expect(payload).not.toHaveProperty("reasoning");
    expect(JSON.stringify(payload.messages)).toContain('"cache_control":{"type":"ephemeral"}');
  });

  it("does not add an off selector to always-on GLM", async () => {
    const payload = await captureRequest("off", "zai-org/GLM-5.3");
    expect(payload).not.toHaveProperty("reasoning");
    expect(payload).not.toHaveProperty("reasoning_effort");
  });
});
