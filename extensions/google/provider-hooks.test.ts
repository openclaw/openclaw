import { createCapturedThinkingConfigStream } from "openclaw/plugin-sdk/provider-test-contracts";
import { describe, expect, it } from "vitest";
import { buildGoogleGeminiCliProvider } from "./gemini-cli-provider.js";
import { GOOGLE_GEMINI_PROVIDER_HOOKS } from "./provider-hooks.js";
import { buildGoogleProvider } from "./provider-registration.js";

describe("GOOGLE_GEMINI_PROVIDER_HOOKS.wrapStreamFn", () => {
  it.each([
    ["google", "gemma-4-26b-a4b-it", "high", { thinkingLevel: "HIGH" }],
    ["google", "google/gemma-4-26b-a4b-it", "high", { thinkingLevel: "HIGH" }],
    ["google", "models/gemma-4-26b-a4b-it", "high", { thinkingLevel: "HIGH" }],
    ["google-vertex", "gemma-4-26b-a4b-it", "low", { thinkingLevel: "MINIMAL" }],
    ["google-vertex", "gemma-4-26b-a4b-it", "off", undefined],
    ["google-vertex", "gemini-2.5-flash", "adaptive", { thinkingBudget: -1 }],
    ["google-vertex", "gemini-3-flash-preview", "adaptive", undefined],
    ["google-gemini-cli", "gemini-3-pro-preview", "high", { thinkingLevel: "HIGH" }],
    ["other", "gemma-4-26b-a4b-it", "high", { thinkingBudget: -1 }],
  ] as const)("normalizes %s %s at %s", (provider, modelId, thinkingLevel, expected) => {
    const api =
      provider === "other"
        ? "openai-completions"
        : provider === "google-vertex"
          ? "google-vertex"
          : "google-generative-ai";
    const capture = createCapturedThinkingConfigStream();
    const wrapped = GOOGLE_GEMINI_PROVIDER_HOOKS.wrapStreamFn({
      provider,
      modelId,
      thinkingLevel,
      streamFn: capture.streamFn,
    });

    void wrapped({ api, provider, id: modelId } as never, { messages: [] } as never, {});

    const capturedConfig = capture.getCapturedPayload()?.config as
      | { thinkingConfig?: unknown }
      | undefined;
    expect(capturedConfig?.thinkingConfig).toEqual(expected);
  });

  it.each([
    ["google-interactions", { fastMode: true }, "priority"],
    ["google-interactions", { fastMode: () => true }, "priority"],
    ["google-interactions", { fastMode: false }, undefined],
    ["google-interactions", { fastMode: true, serviceTier: "flex" }, "flex"],
    ["google-generative-ai", { fastMode: true }, undefined],
  ] as const)("maps %s Fast params %o to service_tier %s", (api, extraParams, expected) => {
    const capture = createCapturedThinkingConfigStream();
    const wrapped = GOOGLE_GEMINI_PROVIDER_HOOKS.wrapStreamFn({
      provider: "google",
      modelId: "gemini-2.5-flash",
      extraParams,
      streamFn: capture.streamFn,
    });
    const baseUrl = "https://generativelanguage.googleapis.com/v1beta";
    void wrapped(
      { api, provider: "google", id: "gemini-2.5-flash", baseUrl } as never,
      { messages: [] } as never,
      {},
    );
    expect((capture.getCapturedPayload() as { service_tier?: unknown })?.service_tier).toBe(
      expected,
    );
  });
});

describe("GOOGLE_GEMINI_PROVIDER_HOOKS.classifyFailoverReason", () => {
  it.each([
    { provider: "google", code: "UNAVAILABLE", expected: "overloaded" },
    { provider: "google-vertex", code: "DEADLINE_EXCEEDED", expected: "timeout" },
    { provider: "google-antigravity", code: "INTERNAL", expected: "server_error" },
    { provider: "google-vertex", code: "INSUFFICIENT_QUOTA", expected: undefined },
  ] as const)("classifies $provider $code as $expected", ({ provider, code, expected }) => {
    expect(
      GOOGLE_GEMINI_PROVIDER_HOOKS.classifyFailoverReason({ provider, errorMessage: "", code }),
    ).toBe(expected);
  });
});

describe("Google subscription refusal guidance", () => {
  it.each([
    ["google", buildGoogleProvider],
    ["google-gemini-cli", buildGoogleGeminiCliProvider],
  ] as const)(
    "registers billing guidance for the captured Ultra-plan refusal with %s",
    (_id, buildProvider) => {
      const provider = buildProvider();
      const refusal = {
        provider: provider.id,
        status: 403,
        errorMessage:
          '403 {"error":{"code":403,"status":"PERMISSION_DENIED","message":"requires an active Google AI Ultra subscription"}}',
      };
      expect(provider.classifyFailoverReason?.(refusal)).toBe("billing");
      expect(provider.formatBillingError?.(refusal)).toEqual({
        message: "This request requires an active Google AI Ultra subscription.",
        actionUrl: "https://one.google.com/about/google-ai-plans/",
      });
      const unknown = { ...refusal, errorMessage: "403 Invalid API key" };
      expect(provider.formatBillingError?.(unknown)).toBeUndefined();
      expect(provider.classifyFailoverReason?.(unknown)).toBeUndefined();
    },
  );
});
