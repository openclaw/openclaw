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

  it("allows CI to floor mock turn timeouts when the gateway runner is saturated", () => {
    const previous = process.env.OPENCLAW_QA_MOCK_TURN_TIMEOUT_FLOOR_MS;
    process.env.OPENCLAW_QA_MOCK_TURN_TIMEOUT_FLOOR_MS = "120000";
    try {
      expect(
        resolveQaLiveTurnTimeoutMs(
          {
            providerMode: "mock-openai",
            primaryModel: "anthropic/claude-opus-4-6",
            alternateModel: "anthropic/claude-sonnet-4-6",
          },
          30_000,
        ),
      ).toBe(120_000);
      expect(
        resolveQaLiveTurnTimeoutMs(
          {
            providerMode: "mock-openai",
            primaryModel: "anthropic/claude-opus-4-6",
            alternateModel: "anthropic/claude-sonnet-4-6",
          },
          180_000,
        ),
      ).toBe(180_000);
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_QA_MOCK_TURN_TIMEOUT_FLOOR_MS;
      } else {
        process.env.OPENCLAW_QA_MOCK_TURN_TIMEOUT_FLOOR_MS = previous;
      }
    }
  });

  it("uses the higher gpt-5 live floor for openai heavy turns", () => {
    expect(
      resolveQaLiveTurnTimeoutMs(
        {
          providerMode: "live-frontier",
          primaryModel: "openai/gpt-5.5",
          alternateModel: "openai/gpt-5.5",
        },
        30_000,
      ),
    ).toBe(360_000);
  });

  it("keeps the standard live floor for other non-anthropic models", () => {
    expect(
      resolveQaLiveTurnTimeoutMs(
        {
          providerMode: "live-frontier",
          primaryModel: "google/gemini-3-flash",
          alternateModel: "google/gemini-3-flash",
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
