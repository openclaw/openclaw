import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

describe("clawrouter provider plugin", () => {
  it("registers managed proxy-key auth and transport routing hooks", () => {
    const captured = capturePluginRegistration(plugin);
    const provider = captured.providers[0];

    expect(provider).toMatchObject({
      id: "clawrouter",
      label: "ClawRouter",
      docsPath: "/providers/clawrouter",
      envVars: ["CLAWROUTER_API_KEY"],
      isModernModelRef: expect.any(Function),
      buildReplayPolicy: expect.any(Function),
      normalizeResolvedModel: expect.any(Function),
      sanitizeReplayHistory: expect.any(Function),
      wrapStreamFn: expect.any(Function),
    });
    expect(provider?.auth[0]).toMatchObject({
      id: "api-key",
      label: "ClawRouter proxy key",
      kind: "api_key",
    });
  });

  it("attaches the resolved proxy key only when dispatching a request", () => {
    const provider = capturePluginRegistration(plugin).providers[0];
    const calls: Array<Parameters<StreamFn>[0]> = [];
    const baseStreamFn: StreamFn = (model) => {
      calls.push(model);
      return {} as ReturnType<StreamFn>;
    };
    const wrapped = provider?.wrapStreamFn?.({
      provider: "clawrouter",
      modelId: "anthropic/default",
      streamFn: baseStreamFn,
    } as never);

    wrapped?.(
      {
        provider: "clawrouter",
        api: "anthropic-messages",
        id: "anthropic/default",
        headers: { "X-Request-ID": "request-1" },
      } as never,
      {} as never,
      { apiKey: "runtime-proxy-key" } as never,
    );
    wrapped?.(
      {
        provider: "clawrouter",
        api: "anthropic-messages",
        id: "anthropic/default",
      } as never,
      {} as never,
      { apiKey: "CLAWROUTER_API_KEY" } as never,
    );

    expect(calls[0]?.headers).toEqual({
      "X-Request-ID": "request-1",
      Authorization: "Bearer runtime-proxy-key",
    });
    expect(calls[1]?.headers).toBeUndefined();
  });

  it("normalizes configured ClawRouter roots to the API base URL", () => {
    const provider = capturePluginRegistration(plugin).providers[0];
    const normalized = provider?.normalizeConfig?.({
      provider: "clawrouter",
      providerConfig: {
        baseUrl: "https://clawrouter.example/",
        models: [],
      },
    } as never);

    expect(normalized).toMatchObject({
      baseUrl: "https://clawrouter.example/v1",
    });
  });

  it("keeps replay handling aligned with each discovered transport", () => {
    const provider = capturePluginRegistration(plugin).providers[0];
    const buildReplayPolicy = provider?.buildReplayPolicy;

    expect(
      buildReplayPolicy?.({
        provider: "clawrouter",
        modelApi: "anthropic-messages",
        modelId: "anthropic/default",
      } as never),
    ).toMatchObject({
      preserveNativeAnthropicToolUseIds: true,
      preserveSignatures: true,
      validateAnthropicTurns: true,
    });
    expect(
      buildReplayPolicy?.({
        provider: "clawrouter",
        modelApi: "google-generative-ai",
        modelId: "google/gemini-default",
      } as never),
    ).toMatchObject({
      validateGeminiTurns: true,
    });
    expect(
      buildReplayPolicy?.({
        provider: "clawrouter",
        modelApi: "openai-responses",
        modelId: "openai/gpt-5.5-mini",
      } as never),
    ).toMatchObject({
      validateGeminiTurns: false,
      validateAnthropicTurns: false,
    });
  });
});
