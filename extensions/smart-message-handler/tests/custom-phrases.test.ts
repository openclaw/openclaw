import { describe, it, expect } from "vitest";
import { matchCustomPhrase } from "../src/custom-phrases.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";
import type { SmartHandlerConfig } from "../src/types.ts";

function configWith(
  phrases: readonly {
    readonly phrase: string;
    readonly kind:
      | "search"
      | "debug"
      | "run"
      | "write"
      | "read"
      | "install"
      | "analyze"
      | "chat"
      | "unknown";
  }[],
): SmartHandlerConfig {
  return { ...DEFAULT_CONFIG, customPhrases: phrases };
}

// ---------------------------------------------------------------------------
// matchCustomPhrase
// ---------------------------------------------------------------------------
describe("matchCustomPhrase", () => {
  it("returns null when customPhrases is empty", () => {
    const result = matchCustomPhrase("hello world", DEFAULT_CONFIG);
    expect(result).toBeNull();
  });

  it("matches an exact substring", () => {
    const cfg = configWith([{ phrase: "又挂了", kind: "debug" }]);
    const result = matchCustomPhrase("这个地方又挂了！", cfg);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("debug");
    expect(result!.phrase).toBe("又挂了");
  });

  it("matches case-insensitively for English phrases", () => {
    const cfg = configWith([{ phrase: "deploy now", kind: "run" }]);
    const result = matchCustomPhrase("Please DEPLOY NOW!", cfg);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("run");
  });

  it("returns the first matching phrase when multiple match", () => {
    const cfg = configWith([
      { phrase: "search", kind: "search" },
      { phrase: "find", kind: "read" },
    ]);
    const result = matchCustomPhrase("search and find files", cfg);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("search");
    expect(result!.phrase).toBe("search");
  });

  it("returns null when no phrase matches", () => {
    const cfg = configWith([{ phrase: "deploy", kind: "run" }]);
    const result = matchCustomPhrase("hello world", cfg);
    expect(result).toBeNull();
  });

  it("trims whitespace from the message before matching", () => {
    const cfg = configWith([{ phrase: "fix", kind: "debug" }]);
    const result = matchCustomPhrase("  fix this bug  ", cfg);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("debug");
  });
});
