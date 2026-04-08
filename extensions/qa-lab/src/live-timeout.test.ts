import { describe, expect, it } from "vitest";
import { resolveQaLiveTurnTimeoutMs } from "./live-timeout.js";

describe("qa live timeout policy", () => {
  it("keeps mock lanes on the caller fallback", () => {
    expect(
      resolveQaLiveTurnTimeoutMs(
        {
          providerMode: "mock-openai",
          primaryModel: "anthropic/claude-sonnet-4-6",
          alternateModel: "anthropic/claude-opus-4-6",
        },
        30_000,
      ),
    ).toBe(30_000);
  });

  it("uses the standard live floor for non-anthropic models", () => {
    expect(
      resolveQaLiveTurnTimeoutMs(
        {
          providerMode: "live-frontier",
          primaryModel: "openai/gpt-5.4",
          alternateModel: "openai/gpt-5.4",
        },
        30_000,
      ),
    ).toBe(120_000);
  });

  it("uses the anthropic floor for sonnet turns", () => {
    expect(
      resolveQaLiveTurnTimeoutMs(
        {
          providerMode: "live-frontier",
          primaryModel: "anthropic/claude-sonnet-4-6",
          alternateModel: "anthropic/claude-opus-4-6",
        },
        30_000,
      ),
    ).toBe(180_000);
  });

  it("uses the opus floor when the switched turn runs on claude opus", () => {
    expect(
      resolveQaLiveTurnTimeoutMs(
        {
          providerMode: "live-frontier",
          primaryModel: "anthropic/claude-sonnet-4-6",
          alternateModel: "anthropic/claude-opus-4-6",
        },
        30_000,
        "anthropic/claude-opus-4-6",
      ),
    ).toBe(240_000);
  });
});
