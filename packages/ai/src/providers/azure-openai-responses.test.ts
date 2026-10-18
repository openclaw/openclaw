import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { createAssistantOutput } from "../transports/assistant-output.js";
import { buildProviderReplayContext } from "../transports/provider-replay-context.js";
import type { Context, Model } from "../types.js";
import { isOpenAICompatibleAzureResponsesBaseUrl } from "./azure-openai-responses-client-compat.js";
import {
  streamAzureOpenAIResponses,
  streamSimpleAzureOpenAIResponses,
} from "./azure-openai-responses.js";

const azureResponsesModel = {
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "azure-openai-responses",
  provider: "azure",
  baseUrl: "https://example.openai.azure.com/openai/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 8192,
} satisfies Model<"azure-openai-responses">;

const context = {
  messages: [{ role: "user", content: "hello", timestamp: 1 }],
} satisfies Context;

type CapturedBody = {
  model?: unknown;
  max_output_tokens?: unknown;
  store?: unknown;
  input?: unknown[];
  reasoning?: { effort?: unknown };
  temperature?: unknown;
};

function captureRequests() {
  const requests: Array<{ url: URL; body: CapturedBody }> = [];
  configureAiTransportHost({
    buildModelFetch: () => async (input, init) => {
      const request = new Request(input, init);
      requests.push({ url: new URL(request.url), body: (await request.json()) as CapturedBody });
      return Response.json({ error: { message: "captured" } }, { status: 400 });
    },
  });
  return requests;
}

let previousHost: ReturnType<typeof getAiTransportHost>;
beforeEach(() => {
  previousHost = getAiTransportHost();
});
afterEach(() => {
  configureAiTransportHost(previousHost);
  vi.unstubAllEnvs();
});

describe("azure-openai-responses", () => {
  it.each([
    [
      "Foundry project endpoint",
      "https://project.services.ai.azure.com/api/projects/demo/openai/v1",
      true,
    ],
    ["private endpoint", "https://aoai.internal/openai/v1", false],
  ])("classifies the %s client path", (_name, baseUrl, expected) => {
    expect(isOpenAICompatibleAzureResponsesBaseUrl(baseUrl)).toBe(expected);
  });

  it("uses the configured Azure resource host and API version at the stream boundary", async () => {
    const requests = captureRequests();
    vi.stubEnv("AZURE_OPENAI_BASE_URL", undefined);
    await streamAzureOpenAIResponses(
      { ...azureResponsesModel, provider: "azure-openai-responses" },
      context,
      {
        apiKey: "test-api-key",
        azureApiVersion: "2026-07-01-preview",
        azureResourceName: "configured-resource",
      },
    ).result();
    const requestUrl = requests[0]?.url;

    expect(requestUrl?.origin).toBe("https://configured-resource.openai.azure.com");
    expect(requestUrl?.pathname).toBe("/openai/v1/responses");
    expect(requestUrl?.searchParams.get("api-version")).toBe("2026-07-01-preview");
  });

  it("sends a case-insensitively resolved deployment name", async () => {
    const requests = captureRequests();
    vi.stubEnv("AZURE_OPENAI_DEPLOYMENT_NAME_MAP", "gpt-5.5=Deployment-GPT-5.5");
    await streamSimpleAzureOpenAIResponses(
      { ...azureResponsesModel, id: "GPT-5.5", name: "GPT-5.5" },
      context,
      { apiKey: "test-key" },
    ).result();
    expect(requests[0]?.body.model).toBe("Deployment-GPT-5.5");
  });

  it("rejects a blank environment API key before sending a request", async () => {
    const requests = captureRequests();
    vi.stubEnv("AZURE_OPENAI_API_KEY", "  ");
    const result = await streamAzureOpenAIResponses(
      { ...azureResponsesModel, provider: "azure-openai-responses" },
      context,
    ).result();
    expect(requests).toHaveLength(0);
    expect(result.errorMessage).toBe(
      "Azure OpenAI API key is required. Set AZURE_OPENAI_API_KEY environment variable or pass it as an argument.",
    );
  });

  it("disables response storage and clamps small output limits", async () => {
    const requests = captureRequests();
    await streamSimpleAzureOpenAIResponses(azureResponsesModel, context, {
      apiKey: "test-api-key",
      maxTokens: 1,
    }).result();
    expect(requests[0]?.body).toMatchObject({ max_output_tokens: 16, store: false });
  });

  it.each<{
    id?: string;
    reasoning: "xhigh" | "max" | undefined;
    compat: Model<"azure-openai-responses">["compat"];
    effort: string;
    temperature: number | undefined;
  }>([
    { reasoning: undefined, compat: undefined, effort: "none", temperature: 0.5 },
    { id: "gpt-6-luna", reasoning: "max", compat: undefined, effort: "high", temperature: 0.5 },
    {
      reasoning: "xhigh",
      compat: {
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
        supportsTemperature: false,
      },
      effort: "xhigh",
      temperature: undefined,
    },
  ])(
    "preserves Azure deployment capabilities for $reasoning with compat=$compat",
    async ({ id = "gpt-6-astra", reasoning, compat, effort, temperature }) => {
      const requests = captureRequests();
      await streamSimpleAzureOpenAIResponses({ ...azureResponsesModel, id, compat }, context, {
        apiKey: "test-api-key",
        reasoning,
        temperature: 0.5,
      }).result();
      expect(requests[0]?.body.reasoning?.effort).toBe(effort);
      expect(requests[0]?.body.temperature).toBe(temperature);
    },
  );

  it("fences compaction replay by the resolved Azure endpoint", async () => {
    const routeA = "https://route-a.openai.azure.com/openai/v1";
    const routeB = "https://route-b.openai.azure.com/openai/v1";
    const sessionId = "azure-replay-session";
    const replayContext = buildProviderReplayContext(
      { ...azureResponsesModel, baseUrl: routeA },
      { sessionId },
    );
    if (!replayContext.baseUrlHash) {
      throw new Error("expected Azure replay route hash");
    }
    const replayMessages = {
      messages: [
        {
          ...createAssistantOutput(azureResponsesModel),
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
    const requests = captureRequests();
    for (const azureBaseUrl of [routeA, routeB]) {
      await streamAzureOpenAIResponses(azureResponsesModel, replayMessages, {
        apiKey: "test-api-key",
        azureBaseUrl,
        sessionId,
      }).result();
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
