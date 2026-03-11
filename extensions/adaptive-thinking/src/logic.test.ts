import { describe, expect, it } from "vitest";
import {
  buildAdaptiveThinkingSignals,
  parseAdaptiveThinkingConfig,
  resolveAdaptiveThinkingOverride,
} from "./logic.js";

describe("adaptive-thinking extension logic", () => {
  it("parses config with sane defaults", () => {
    expect(parseAdaptiveThinkingConfig(undefined)).toEqual({
      enabled: true,
      confidenceThreshold: undefined,
      recentMessages: undefined,
    });
  });

  it("detects debugging signals and raises thinking", () => {
    expect(
      resolveAdaptiveThinkingOverride({
        config: { enabled: true, confidenceThreshold: 0.8 },
        event: {
          prompt: "debug this failing test in the TypeScript repo",
          currentThinkingDefault: "low",
        },
      }),
    ).toBe("medium");
  });

  it("does not override when explicit or session thinking is already set", () => {
    expect(
      resolveAdaptiveThinkingOverride({
        config: { enabled: true },
        event: {
          prompt: "debug this failing test",
          currentThinkingDefault: "low",
          explicitThinkingLevel: "high",
        },
      }),
    ).toBeUndefined();

    expect(
      resolveAdaptiveThinkingOverride({
        config: { enabled: true },
        event: {
          prompt: "debug this failing test",
          currentThinkingDefault: "low",
          sessionThinkingLevel: "medium",
        },
      }),
    ).toBeUndefined();
  });

  it("treats adaptive session/explicit placeholders as eligible for plugin override", () => {
    expect(
      resolveAdaptiveThinkingOverride({
        config: { enabled: true, confidenceThreshold: 0.8 },
        event: {
          prompt: "debug this failing test in the TypeScript repo",
          currentThinkingDefault: "low",
          sessionThinkingLevel: "adaptive",
        },
      }),
    ).toBe("medium");
  });

  it("builds attachment and long-context signals from event context", () => {
    const signals = buildAdaptiveThinkingSignals({
      prompt: "please inspect this repo file",
      recentMessages: ["x".repeat(1300)],
      attachmentCount: 1,
    });
    expect(signals).toContain("attachments");
    expect(signals).toContain("long_context");
    expect(signals).toContain("coding");
  });
});
