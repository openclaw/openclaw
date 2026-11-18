import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { createAssistantOutput } from "../transports/assistant-output.js";
import { buildProviderReplayContext } from "../transports/provider-replay-context.js";
import type { Context, Model } from "../types.js";
import { isOpenAICompatibleAzureResponsesBaseUrl } from "./azure-openai-responses-client-compat.js";
import {
  streamAzureOpenAIResponses as stream,
  streamSimpleAzureOpenAIResponses as streamSimple,
} from "./azure-openai-responses.js";
import { makeProviderModel } from "./provider-model.test-support.js";

const model = makeProviderModel("azure-openai-responses", "azure", "gpt-5.5", {
  name: "GPT-5.5",
  baseUrl: "https://example.openai.azure.com/openai/v1",
  contextWindow: 200000,
});

const context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] } satisfies Context;

const directModel = { ...model, provider: "azure-openai-responses" };
const run = (
  options: Parameters<typeof stream>[2] = {},
  messages: Context = context,
  target = directModel,
) => stream(target, messages, { apiKey: "test-api-key", ...options }).result();
const runSimple = (options: Parameters<typeof streamSimple>[2] = {}, target = model) =>
  streamSimple(target, context, { apiKey: "test-api-key", ...options }).result();

type CapturedBody = {
  model?: unknown;
  prompt_cache_key?: unknown;
  input?: unknown[];
  reasoning?: { effort?: unknown };
  temperature?: unknown;
};

let requests: Array<{ url: URL; body: CapturedBody }>;
let previousHost: ReturnType<typeof getAiTransportHost>;
beforeEach(() => {
  previousHost = getAiTransportHost();
  requests = [];
  configureAiTransportHost({
    buildModelFetch: () => async (input, init) => {
      const request = new Request(input, init);
      requests.push({ url: new URL(request.url), body: (await request.json()) as CapturedBody });
      return Response.json({ error: { message: "captured" } }, { status: 400 });
    },
  });
});
afterEach(() => {
  configureAiTransportHost(previousHost);
  vi.unstubAllEnvs();
});

describe("azure-openai-responses", () => {
  it.each([
    ["https://project.services.ai.azure.com/api/projects/demo/openai/v1", true],
    ["https://aoai.internal/openai/v1", false],
  ])("classifies the %s client path", (baseUrl, expected) => {
    expect(isOpenAICompatibleAzureResponsesBaseUrl(baseUrl)).toBe(expected);
  });

  it("uses the configured Azure resource host and API version at the stream boundary", async () => {
    vi.stubEnv("AZURE_OPENAI_BASE_URL", undefined);
    await run({
      azureApiVersion: "2026-07-01-preview",
      azureResourceName: "configured-resource",
    });
    expect(requests[0]?.url.href).toBe(
      "https://configured-resource.openai.azure.com/openai/v1/responses?api-version=2026-07-01-preview",
    );
  });

  it("sends a case-insensitively resolved deployment name", async () => {
    vi.stubEnv("AZURE_OPENAI_DEPLOYMENT_NAME_MAP", "gpt-5.5=Deployment-GPT-5.5");
    await runSimple({}, { ...model, id: "GPT-5.5", name: "GPT-5.5" });
    expect(requests[0]?.body.model).toBe("Deployment-GPT-5.5");
  });

  it("rejects a blank environment API key before sending a request", async () => {
    vi.stubEnv("AZURE_OPENAI_API_KEY", "  ");
    const result = await stream(directModel, context).result();
    expect(requests).toHaveLength(0);
    expect(result.errorMessage).toBe(
      "Azure OpenAI API key is required. Set AZURE_OPENAI_API_KEY environment variable or pass it as an argument.",
    );
  });

  it("preserves the selected Code Mode tools at the shared Responses boundary", async () => {
    const tools = ["exec", "wait", "computer"].map((name) => ({
      name,
      description: name,
      parameters: Type.Object({}),
    }));
    await run({ openclawCodeModeToolSurface: true }, { ...context, tools });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toMatchObject({
      tools: ["computer", "exec", "wait"].map((name) => ({ type: "function", name })),
    });
  });

  it("disables response storage and clamps small output limits", async () => {
    await runSimple({ maxTokens: 1 });
    expect(requests[0]?.body).toMatchObject({ max_output_tokens: 16, store: false });
  });

  it.each([
    [undefined, undefined, "azure-cache-session"],
    [true, "short", "azure-cache-session"],
    [false, "short", undefined],
    [false, "long", undefined],
    [true, "none", undefined],
  ] as const)(
    "serializes cache-key support %s with retention %s through both Azure clients",
    async (supportsPromptCacheKey, cacheRetention, expected) => {
      for (const baseUrl of [model.baseUrl, "https://project.services.ai.azure.com/openai/v1"]) {
        await runSimple(
          { sessionId: "azure-cache-session", cacheRetention },
          { ...model, baseUrl, compat: { supportsPromptCacheKey } },
        );
      }
      expect(requests.map(({ body }) => body.prompt_cache_key)).toEqual([expected, expected]);
    },
  );

  const declaredCompat: Model<"azure-openai-responses">["compat"] = {
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
    supportsTemperature: false,
  };
  it.each([
    ["unknown-deployment", undefined, undefined, undefined, 0.5],
    ["unknown-deployment", "max", undefined, "high", 0.5],
    ["declared-deployment", "xhigh", declaredCompat, "xhigh", undefined],
  ] as const)(
    "preserves %s deployment capabilities for %s",
    async (id, reasoning, compat, effort, temperature) => {
      await runSimple({ reasoning, temperature: 0.5 }, { ...model, id, compat });
      const body = requests[0]?.body;
      expect([body?.reasoning?.effort, body?.temperature]).toEqual([effort, temperature]);
    },
  );

  it("fences compaction replay by the resolved Azure endpoint", async () => {
    const routeA = "https://route-a.openai.azure.com/openai/v1";
    const routeB = "https://route-b.openai.azure.com/openai/v1";
    const sessionId = "azure-replay-session";
    const replayContext = buildProviderReplayContext({ ...model, baseUrl: routeA }, { sessionId });
    if (!replayContext.baseUrlHash) {
      throw new Error("expected Azure replay route hash");
    }
    const replayMessages = {
      messages: [
        {
          ...createAssistantOutput(model),
          content: [{ type: "text", text: "earlier" }],
          providerReplay: {
            v: 1,
            type: "openai-responses-compaction",
            data: "opaque-compaction-route-a",
            ...replayContext,
            baseUrlHash: replayContext.baseUrlHash,
          },
          timestamp: 1,
        },
        { role: "user", content: "continue", timestamp: 2 },
      ],
    } satisfies Context;
    for (const azureBaseUrl of [routeA, routeB]) {
      await run({ azureBaseUrl, sessionId }, replayMessages, model);
    }
    const inputs = requests.map(({ body }) => body.input ?? []);

    expect(inputs[0]).toContainEqual(
      expect.objectContaining({
        type: "compaction",
        encrypted_content: "opaque-compaction-route-a",
      }),
    );
    expect(inputs[1]).not.toContainEqual(expect.objectContaining({ type: "compaction" }));
  });
});
