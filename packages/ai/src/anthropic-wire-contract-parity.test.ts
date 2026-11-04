import { describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "./host.js";
import {
  anthropicModel,
  context,
  captureAnthropicRequest,
  registerParityHostLifecycle,
} from "./provider-transport-parity.test-support.js";
import { streamAnthropic } from "./providers/anthropic.js";

// Both Anthropic transports keep API version 2023-06-01 and X-Api-Key routing; SDK 1.x
// defaults to 2026-10-21 and bearer API keys.
describe("Anthropic wire contract", () => {
  registerParityHostLifecycle();

  it.each([
    {
      name: "direct API key",
      apiKey: "sk-ant-api03-synthetic",
      model: {},
      headers: undefined,
      xApiKey: "sk-ant-api03-synthetic",
      authorization: null,
    },
    {
      name: "OAuth token",
      apiKey: "sk-ant-oat01-synthetic",
      model: { id: "claude-fable-5-1" },
      headers: undefined,
      xApiKey: null,
      authorization: "Bearer sk-ant-oat01-synthetic",
    },
    {
      name: "Cloudflare AI Gateway",
      apiKey: "sk-ant-api03-synthetic",
      model: {
        provider: "cloudflare-ai-gateway",
        baseUrl: "https://gateway.ai.cloudflare.com/v1/account/gateway/anthropic",
        headers: { "cf-aig-authorization": "Bearer gateway-token" },
      },
      headers: undefined,
      xApiKey: "sk-ant-api03-synthetic",
      authorization: null,
    },
    {
      name: "caller key override",
      apiKey: "sk-ant-api03-synthetic",
      model: {},
      headers: { "X-Api-Key": "sk-ant-api03-override" },
      xApiKey: "sk-ant-api03-override",
      authorization: null,
    },
  ])("sends $name credentials on API version 2023-06-01", async (testCase) => {
    for (const implementation of ["provider", "transport"] as const) {
      const { headers } = await captureAnthropicRequest(implementation, {
        apiKey: testCase.apiKey,
        model: testCase.model,
        headers: testCase.headers,
      });
      expect(headers.get("anthropic-version"), implementation).toBe("2023-06-01");
      expect(headers.get("x-api-key"), implementation).toBe(testCase.xApiKey);
      expect(headers.get("authorization"), implementation).toBe(testCase.authorization);
      if (testCase.model.headers) {
        expect(headers.get("cf-aig-authorization"), implementation).toBe("Bearer gateway-token");
      }
    }
  });

  it("rejects a missing provider credential before sending a request", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 401 }));
    configureAiTransportHost({ ...getAiTransportHost(), buildModelFetch: () => fetch });
    const terminal = await streamAnthropic(anthropicModel, context, { apiKey: "" }).result();
    expect(fetch).not.toHaveBeenCalled();
    expect(terminal.stopReason).toBe("error");
    expect(terminal.errorMessage).toContain("Could not resolve authentication method");
  });

  it("keeps custom temperature for Claude models that accept it", async () => {
    for (const implementation of ["provider", "transport"] as const) {
      const { payload } = await captureAnthropicRequest(implementation, {
        reasoning: undefined,
        temperature: 0.2,
      });
      expect(payload.temperature, implementation).toBe(0.2);
    }
  });
});
