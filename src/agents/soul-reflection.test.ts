import { describe, expect, it } from "vitest";
import {
  buildReflectionPrompt,
  DEFAULT_TURN_INTERVAL,
  REFLECTION_PROMPT,
  resolveTurnInterval,
  shouldFireReflection,
  SIGNAL_KEYWORDS,
} from "./soul-reflection.js";

describe("shouldFireReflection", () => {
  it("returns null when autoUpdate is not enabled", () => {
    expect(
      shouldFireReflection({
        userMessage: "please stop using em-dashes",
        turnsSinceLast: 99,
        config: undefined,
      }),
    ).toBeNull();
    expect(
      shouldFireReflection({
        userMessage: "please stop using em-dashes",
        turnsSinceLast: 99,
        config: { autoUpdate: false },
      }),
    ).toBeNull();
  });

  it("returns null on an empty or whitespace-only user message", () => {
    expect(
      shouldFireReflection({
        userMessage: "   ",
        turnsSinceLast: 100,
        config: { autoUpdate: true },
      }),
    ).toBeNull();
  });

  it("fires keyword trigger on signal keywords (case-insensitive, whole-word)", () => {
    for (const keyword of SIGNAL_KEYWORDS) {
      const result = shouldFireReflection({
        userMessage: `I would ${keyword} do that, thanks`,
        turnsSinceLast: 0,
        config: { autoUpdate: true },
      });
      expect(result).toMatchObject({ kind: "keyword" });
    }
  });

  it("does not match signal keywords that are substrings of other words", () => {
    expect(
      shouldFireReflection({
        userMessage: "preferential treatment is unrelated",
        turnsSinceLast: 0,
        config: { autoUpdate: true },
      }),
    ).toBeNull();
    expect(
      shouldFireReflection({
        userMessage: "the unstoppable freight train",
        turnsSinceLast: 0,
        config: { autoUpdate: true },
      }),
    ).toBeNull();
  });

  it("prefers keyword trigger over interval trigger when both apply", () => {
    const result = shouldFireReflection({
      userMessage: "please be terse",
      turnsSinceLast: 99,
      config: { autoUpdate: true, reflectionTurnInterval: 5 },
    });
    expect(result?.kind).toBe("keyword");
  });

  it("fires interval trigger when turnsSinceLast meets the configured interval", () => {
    const result = shouldFireReflection({
      userMessage: "ok so let's look at the next file",
      turnsSinceLast: 5,
      config: { autoUpdate: true, reflectionTurnInterval: 5 },
    });
    expect(result).toEqual({ kind: "interval", turnsSinceLast: 5 });
  });

  it("does not fire interval trigger below the threshold", () => {
    expect(
      shouldFireReflection({
        userMessage: "ok next file",
        turnsSinceLast: 4,
        config: { autoUpdate: true, reflectionTurnInterval: 5 },
      }),
    ).toBeNull();
  });

  it("falls back to the default interval when config interval is missing or invalid", () => {
    expect(resolveTurnInterval(undefined)).toBe(DEFAULT_TURN_INTERVAL);
    expect(resolveTurnInterval(0)).toBe(DEFAULT_TURN_INTERVAL);
    expect(resolveTurnInterval(Number.NaN)).toBe(DEFAULT_TURN_INTERVAL);
    expect(resolveTurnInterval(Number.POSITIVE_INFINITY)).toBe(DEFAULT_TURN_INTERVAL);
    expect(resolveTurnInterval(7.9)).toBe(7);
  });
});

describe("buildReflectionPrompt", () => {
  it("embeds the core reflection prompt and the trigger reason", () => {
    const prompt = buildReflectionPrompt({
      trigger: { kind: "keyword", matched: "stop" },
      recentUserMessage: "please stop using em-dashes",
    });
    expect(prompt.startsWith(REFLECTION_PROMPT)).toBe(true);
    expect(prompt).toContain('signal keyword "stop"');
    expect(prompt).toContain("please stop using em-dashes");
  });

  it("formats the interval trigger reason with the turn count", () => {
    const prompt = buildReflectionPrompt({
      trigger: { kind: "interval", turnsSinceLast: 5 },
      recentUserMessage: "next file",
    });
    expect(prompt).toContain("5 turns since last reflection");
  });
});
