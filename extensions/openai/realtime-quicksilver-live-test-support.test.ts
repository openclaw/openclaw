import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getRuntimeConfig: vi.fn() }));

vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
}));

import { resolveConfiguredLiveQuicksilverModel } from "./realtime-quicksilver-live-test-support.js";

const directModel = "gpt-live-direct-fixture";
const providerModel = "gpt-live-provider-fixture";

describe("private realtime live model selection", () => {
  it.each([
    [
      "prefers a valid Talk-level model over provider configuration",
      { provider: "openai", model: directModel, providers: { openai: { model: providerModel } } },
      directModel,
    ],
    [
      "rejects an ineligible explicit Talk-level model instead of falling through",
      {
        provider: " OPENAI ",
        model: "public-realtime-fixture",
        providers: { OpenAI: { model: providerModel } },
      },
      undefined,
    ],
    [
      "uses a sole OpenAI provider model when no provider is selected",
      { providers: { OpenAI: { model: providerModel } } },
      providerModel,
    ],
    ["rejects missing live configuration", undefined, undefined],
    [
      "rejects an explicitly selected ineligible provider",
      { provider: "custom", model: directModel, providers: { custom: { model: providerModel } } },
      undefined,
    ],
    [
      "rejects an implicitly selected ineligible provider",
      { model: directModel, providers: { custom: { model: providerModel } } },
      undefined,
    ],
  ])("%s", (_label, realtime, expected) => {
    mocks.getRuntimeConfig.mockReturnValue(realtime ? { talk: { realtime } } : {});
    expect(resolveConfiguredLiveQuicksilverModel()).toBe(expected);
  });
});
