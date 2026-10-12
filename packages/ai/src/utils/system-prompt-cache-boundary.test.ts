// System prompt cache-boundary tests cover the internal marker that separates
// stable prompt text from dynamic per-turn additions.
import { describe, expect, it } from "vitest";
import {
  ensureSystemPromptCacheBoundary,
  prependSystemPromptAdditionAfterCacheBoundary,
  splitSystemPromptCacheBoundary,
  stripSystemPromptCacheBoundary,
  SYSTEM_PROMPT_CACHE_BOUNDARY,
  SYSTEM_PROMPT_RELOCATABLE_BOUNDARY,
  SYSTEM_PROMPT_RELOCATABLE_BOUNDARY_END,
} from "./system-prompt-cache-boundary.js";

describe("system prompt cache boundary helpers", () => {
  it("normalizes malformed surrogates and whitespace in dynamic prompt sections", () => {
    const high = String.fromCharCode(0xd83d);

    expect(
      prependSystemPromptAdditionAfterCacheBoundary({
        systemPrompt: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic${high} suffix  \r\n\r\nMore detail \t\r\n`,
        systemPromptAddition: `  Per-turn${high} context \r\nSecond line\t\r\n`,
      }),
    ).toBe(
      `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Per-turn context\nSecond line\n\nDynamic suffix\n\nMore detail`,
    );
  });
});

describe("ensureSystemPromptCacheBoundary", () => {
  it("returns a marker-bearing prompt unchanged", () => {
    const prompt = `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic suffix`;
    expect(ensureSystemPromptCacheBoundary(prompt)).toBe(prompt);
  });

  it("uses a per-turn addition directly when the base prompt is empty", () => {
    expect(
      prependSystemPromptAdditionAfterCacheBoundary({
        systemPrompt: ensureSystemPromptCacheBoundary(""),
        systemPromptAddition: "Per-turn media task hint",
      }),
    ).toBe("Per-turn media task hint");
  });

  it("lets a per-turn addition split into the uncached suffix for a marker-free prompt", () => {
    // Marker-free overrides become stable prefixes; additions stay in the
    // dynamic suffix so prompt-cache bytes remain deterministic.
    const result = prependSystemPromptAdditionAfterCacheBoundary({
      systemPrompt: ensureSystemPromptCacheBoundary("Marker-free override"),
      systemPromptAddition: "Per-turn media task hint",
    });
    expect(splitSystemPromptCacheBoundary(result)).toEqual({
      stablePrefix: "Marker-free override",
      dynamicSuffix: "Per-turn media task hint",
    });
  });
});

describe("relocatable region splitting", () => {
  const marked = (facts: string) =>
    `${SYSTEM_PROMPT_RELOCATABLE_BOUNDARY}${facts}${SYSTEM_PROMPT_RELOCATABLE_BOUNDARY_END}`;

  it("strips both markers from prompt text", () => {
    const stripped = stripSystemPromptCacheBoundary(
      `Behavioral guidance${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic suffix${marked("Runtime: session=alpha")}`,
    );
    expect(stripped).not.toContain("OPENCLAW-RELOCATABLE-BOUNDARY");
    expect(stripped).toContain("Runtime: session=alpha");
    expect(stripped).toBe("Behavioral guidance\nDynamic suffix\nRuntime: session=alpha");
  });
});
