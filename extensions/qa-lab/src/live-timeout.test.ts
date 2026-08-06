// Qa Lab tests cover live timeout plugin behavior.
import { describe, expect, it } from "vitest";
import { resolveQaLiveTurnTimeoutMs } from "./live-timeout.js";

function withLiveTurnTimeoutEnv<T>(value: string | undefined, run: () => T): T {
  const previous = process.env.OPENCLAW_QA_LIVE_TURN_TIMEOUT_MS;
  try {
    if (value === undefined) {
      delete process.env.OPENCLAW_QA_LIVE_TURN_TIMEOUT_MS;
    } else {
      process.env.OPENCLAW_QA_LIVE_TURN_TIMEOUT_MS = value;
    }
    return run();
  } finally {
    if (previous === undefined) {
      delete process.env.OPENCLAW_QA_LIVE_TURN_TIMEOUT_MS;
    } else {
      process.env.OPENCLAW_QA_LIVE_TURN_TIMEOUT_MS = previous;
    }
  }
}

describe("qa live timeout policy", () => {
  it("keeps mock lanes on the caller fallback", () => {
    expect(
      resolveQaLiveTurnTimeoutMs(
        {
          providerMode: "mock-openai",
          primaryModel: "anthropic/claude-sonnet-4-6",
          alternateModel: "anthropic/claude-opus-4-8",
        },
        30_000,
      ),
    ).toBe(30_000);
  });

  it("uses the higher gpt-5 live floor for openai heavy turns", () => {
    expect(
      resolveQaLiveTurnTimeoutMs(
        {
          providerMode: "live-frontier",
          primaryModel: "openai/gpt-5.6-luna",
          alternateModel: "openai/gpt-5.6-luna",
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
          alternateModel: "anthropic/claude-opus-4-8",
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
          alternateModel: "anthropic/claude-opus-4-8",
        },
        30_000,
        "anthropic/claude-opus-4-8",
      ),
    ).toBe(240_000);
  });

  it("uses the anthropic floor for claude-cli sonnet turns", () => {
    expect(
      resolveQaLiveTurnTimeoutMs(
        {
          providerMode: "live-frontier",
          primaryModel: "claude-cli/claude-sonnet-4-6",
          alternateModel: "claude-cli/claude-opus-4-8",
        },
        30_000,
      ),
    ).toBe(180_000);
  });

  it("uses the opus floor for claude-cli opus turns", () => {
    expect(
      resolveQaLiveTurnTimeoutMs(
        {
          providerMode: "live-frontier",
          primaryModel: "claude-cli/claude-opus-4-8",
          alternateModel: "claude-cli/claude-opus-4-8",
        },
        30_000,
      ),
    ).toBe(240_000);
  });

  it("allows live frontier runs to raise the turn timeout floor with an env override", () => {
    withLiveTurnTimeoutEnv("420000", () => {
      expect(
        resolveQaLiveTurnTimeoutMs(
          {
            providerMode: "live-frontier",
            primaryModel: "google/gemini-3-flash",
            alternateModel: "google/gemini-3-flash",
          },
          30_000,
        ),
      ).toBe(420_000);
    });
  });

  it("does not let lower env override values shorten mock lane fallbacks", () => {
    withLiveTurnTimeoutEnv("45000", () => {
      expect(
        resolveQaLiveTurnTimeoutMs(
          {
            providerMode: "mock-openai",
            primaryModel: "google/gemini-3-flash",
            alternateModel: "google/gemini-3-flash",
          },
          180_000,
        ),
      ).toBe(180_000);
    });
  });

  it("does not let lower env override values shorten generic live-frontier fallbacks", () => {
    withLiveTurnTimeoutEnv("45000", () => {
      expect(
        resolveQaLiveTurnTimeoutMs(
          {
            providerMode: "live-frontier",
            primaryModel: "google/gemini-3-flash",
            alternateModel: "google/gemini-3-flash",
          },
          180_000,
        ),
      ).toBe(180_000);
    });
  });

  it("keeps provider floors when the live turn timeout env override is lower", () => {
    withLiveTurnTimeoutEnv("45000", () => {
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
  });

  it("ignores invalid live turn timeout env override values", () => {
    withLiveTurnTimeoutEnv("1e3", () => {
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
  });
});
