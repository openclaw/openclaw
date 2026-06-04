import { describe, expect, it } from "vitest";
import { supportsModelTools } from "./model-tool-support.js";

describe("supportsModelTools", () => {
  it("defaults to false for unknown providers with no compat override", () => {
    expect(supportsModelTools({ provider: "unknown" } as never)).toBe(false);
    expect(supportsModelTools({} as never)).toBe(false);
  });

  it("defaults to true for direct providers with native tool support", () => {
    expect(supportsModelTools({ provider: "openai" } as never)).toBe(true);
    expect(supportsModelTools({ provider: "openai-codex" } as never)).toBe(true);
    expect(supportsModelTools({ provider: "anthropic" } as never)).toBe(true);
    expect(supportsModelTools({ provider: "google" } as never)).toBe(true);
  });

  it("returns true when compat.supportsTools is true", () => {
    expect(supportsModelTools({ compat: { supportsTools: true } } as never)).toBe(true);
  });

  it("returns false when compat.supportsTools is false", () => {
    expect(
      supportsModelTools({
        provider: "openai",
        compat: { supportsTools: false },
      } as never),
    ).toBe(false);
  });
});
