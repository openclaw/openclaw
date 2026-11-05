import { createCapturedThinkingConfigStream } from "openclaw/plugin-sdk/provider-test-contracts";
import { describe, expect, it } from "vitest";
import { GOOGLE_GEMINI_PROVIDER_HOOKS } from "./provider-hooks.js";

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
    {
      name: "sets service_tier=priority when fastMode is true on google-interactions",
      provider: "google",
      api: "google-interactions",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      extraParams: { fastMode: true },
      expectedServiceTier: "priority",
    },
    {
      name: "evaluates dynamic fastMode function per request",
      provider: "google",
      api: "google-interactions",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      extraParams: { fastMode: () => true },
      expectedServiceTier: "priority",
    },
    {
      name: "omits service_tier when fastMode is false",
      provider: "google",
      api: "google-interactions",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      extraParams: { fastMode: false },
      expectedServiceTier: undefined,
    },
    {
      name: "lets explicit serviceTier override fastMode",
      provider: "google",
      api: "google-interactions",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      extraParams: { fastMode: true, serviceTier: "flex" },
      expectedServiceTier: "flex",
    },
    {
      name: "does not set service_tier on google-generative-ai",
      provider: "google",
      api: "google-generative-ai",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      extraParams: { fastMode: true },
      expectedServiceTier: undefined,
    },
    {
      name: "does not set service_tier on google-vertex",
      provider: "google-vertex",
      api: "google-vertex",
      baseUrl: "https://us-central1-aiplatform.googleapis.com/v1",
      extraParams: { fastMode: true },
      expectedServiceTier: undefined,
    },
  ])("$name", ({ provider, api, baseUrl, extraParams, expectedServiceTier }) => {
    const capture = createCapturedThinkingConfigStream();
    const wrapped = GOOGLE_GEMINI_PROVIDER_HOOKS.wrapStreamFn({
      provider,
      modelId: "gemini-2.5-flash",
      extraParams,
      streamFn: capture.streamFn,
    });

    void wrapped(
      { api, provider, id: "gemini-2.5-flash", baseUrl } as never,
      { messages: [] } as never,
      {},
    );

    const payload = capture.getCapturedPayload() as { service_tier?: unknown } | undefined;
    expect(payload?.service_tier).toBe(expectedServiceTier);
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
