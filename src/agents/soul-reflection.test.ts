import { describe, expect, it } from "vitest";
import {
  buildReflectionPrompt,
  REFLECTION_PROMPT,
  shouldFireReflection,
  SIGNAL_KEYWORDS,
} from "./soul-reflection.js";

describe("shouldFireReflection", () => {
  it("returns null when autoUpdate is not enabled", () => {
    expect(
      shouldFireReflection({
        userMessage: "stop using em-dashes",
        config: undefined,
      }),
    ).toBeNull();
    expect(
      shouldFireReflection({
        userMessage: "stop using em-dashes",
        config: { autoUpdate: false },
      }),
    ).toBeNull();
  });

  it("returns null on an empty or whitespace-only user message", () => {
    expect(
      shouldFireReflection({
        userMessage: "   ",
        config: { autoUpdate: true },
      }),
    ).toBeNull();
  });

  it("fires keyword trigger on signal keywords (case-insensitive, whole-word)", () => {
    for (const keyword of SIGNAL_KEYWORDS) {
      const result = shouldFireReflection({
        userMessage: `I would ${keyword} do that, thanks`,
        config: { autoUpdate: true },
      });
      expect(result).toMatchObject({ kind: "keyword" });
    }
  });

  it("does not match signal keywords that are substrings of other words", () => {
    expect(
      shouldFireReflection({
        userMessage: "preferential treatment is unrelated",
        config: { autoUpdate: true },
      }),
    ).toBeNull();
    expect(
      shouldFireReflection({
        userMessage: "the unstoppable freight train",
        config: { autoUpdate: true },
      }),
    ).toBeNull();
  });

  it("does not treat 'please' as a signal keyword", () => {
    expect(
      shouldFireReflection({
        userMessage: "please summarize this file",
        config: { autoUpdate: true },
      }),
    ).toBeNull();
  });

  it("returns null when no signal keyword is present", () => {
    expect(
      shouldFireReflection({
        userMessage: "ok so let's look at the next file",
        config: { autoUpdate: true },
      }),
    ).toBeNull();
  });
});

describe("buildReflectionPrompt", () => {
  it("embeds the core reflection prompt and the trigger reason", () => {
    const prompt = buildReflectionPrompt({
      trigger: { kind: "keyword", matched: "stop" },
      recentUserMessage: "stop using em-dashes",
    });
    expect(prompt.startsWith(REFLECTION_PROMPT)).toBe(true);
    expect(prompt).toContain('signal keyword "stop"');
    expect(prompt).toContain("stop using em-dashes");
  });
});
