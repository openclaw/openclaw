// xAI tests cover the plugin-owned replay policy for Responses endpoints.
import { describe, expect, it } from "vitest";
import { buildXaiReplayPolicy } from "./replay-policy.js";

const basePolicy = () => ({
  sanitizeToolCallIds: true as const,
  toolCallIdMode: "strict" as const,
  allowSyntheticToolResults: true as const,
});

describe("buildXaiReplayPolicy", () => {
  it("keeps the runtime context carrier for Responses endpoints", () => {
    const policy = buildXaiReplayPolicy(() => basePolicy())({
      provider: "xai",
      modelId: "grok-4.6",
      modelApi: "openai-responses",
    });

    expect(policy).toEqual({ ...basePolicy(), appendOnlyRuntimeContext: true });
  });

  it.each(["openai-chatgpt-responses", "azure-openai-responses"])(
    "keeps the carrier for the %s Responses variant",
    (modelApi) => {
      const policy = buildXaiReplayPolicy(() => basePolicy())({ provider: "xai", modelApi });

      expect(policy?.appendOnlyRuntimeContext).toBe(true);
    },
  );

  it("leaves completions replay untouched", () => {
    const policy = buildXaiReplayPolicy(() => basePolicy())({
      provider: "xai",
      modelApi: "openai-completions",
    });

    expect(policy).toEqual(basePolicy());
    expect(policy?.appendOnlyRuntimeContext).toBeUndefined();
  });

  it("returns undefined when the base family policy does not apply", () => {
    const policy = buildXaiReplayPolicy(() => undefined)({
      provider: "xai",
      modelApi: "openai-responses",
    });

    expect(policy).toBeUndefined();
  });
});

describe("xAI provider replay hook wiring", () => {
  it("registers the Responses carrier fix on the plugin entry", async () => {
    const { registerSingleProviderPlugin } =
      await import("openclaw/plugin-sdk/plugin-test-runtime");
    const plugin = (await import("./index.js")).default;
    const provider = await registerSingleProviderPlugin(plugin as never);

    expect(
      provider.buildReplayPolicy?.({ provider: "xai", modelApi: "openai-responses" } as never)
        ?.appendOnlyRuntimeContext,
    ).toBe(true);
    expect(
      provider.buildReplayPolicy?.({ provider: "xai", modelApi: "openai-completions" } as never)
        ?.appendOnlyRuntimeContext,
    ).toBeUndefined();
  });
});
