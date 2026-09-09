// Provider-auth safety checks for native OpenAI Responses egress.
import type { Model } from "@openclaw/llm-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";

type SdkResponse = { data: AsyncIterable<unknown>; response: Response };

const transportState = vi.hoisted(() => ({
  clients: [] as Array<{ apiKey?: string }>,
  outcomes: [] as Array<Error | SdkResponse>,
}));

vi.mock("openai", () => {
  class MockOpenAI {
    responses = {
      create: () => {
        const outcome = transportState.outcomes.shift() ?? new Error("Unexpected SSE request");
        return {
          withResponse: async () => {
            if (outcome instanceof Error) {
              throw outcome;
            }
            return outcome;
          },
        };
      },
    };

    constructor(options: { apiKey?: string }) {
      transportState.clients.push({ apiKey: options.apiKey });
    }
  }
  return { default: MockOpenAI, AzureOpenAI: MockOpenAI };
});

vi.mock("openai/resources/responses/ws.js", () => ({
  ResponsesWS: function UnexpectedResponsesWS() {
    throw new Error("auth tests must not construct a WebSocket");
  },
}));

import {
  OpenAIResponsesMissingProviderAuthError,
  createOpenAIResponsesTransportStreamFn,
  resolveOpenAIResponsesApiKeyForEgress,
} from "./openai-responses-client.js";

const initialHost = getAiTransportHost();

const model = {
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8192,
} satisfies Model<"openai-responses">;

describe("native OpenAI Responses provider auth", () => {
  beforeEach(() => {
    transportState.clients = [];
    transportState.outcomes = [];
    vi.stubEnv("OPENAI_API_KEY", "");
    configureAiTransportHost(initialHost);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    configureAiTransportHost(initialHost);
  });

  it("fails closed before SDK client construction when native OpenAI auth is missing", async () => {
    expect(() => resolveOpenAIResponsesApiKeyForEgress({ model })).toThrow(
      OpenAIResponsesMissingProviderAuthError,
    );

    const stream = createOpenAIResponsesTransportStreamFn()(
      model,
      { messages: [{ role: "user", content: "hello" }], tools: [] },
      { transport: "sse" } as never,
    );
    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("ProviderAuthUnavailable");
    expect(result.errorMessage).toContain("credentialPresent=false");
    expect(transportState.clients).toHaveLength(0);
  });

  it("allows synthetic test credentials and keeps managed transports host-owned", () => {
    expect(
      resolveOpenAIResponsesApiKeyForEgress({
        model,
        optionApiKey: "synthetic-openai-credential",
      }),
    ).toBe("synthetic-openai-credential");

    configureAiTransportHost({
      ...initialHost,
      requiresManagedTransport: (candidate) => candidate === model,
    });
    expect(resolveOpenAIResponsesApiKeyForEgress({ model })).toBe("");
  });
});
