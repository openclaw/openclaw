import { describe, expect, it } from "vitest";
import { isCliRuntimeId, resolveCliRuntimeExecutionProvider } from "./model-runtime-aliases.js";

describe("model-runtime-aliases", () => {
  it("identifies CLI runtime ids separately from embedded harness ids", () => {
    expect(isCliRuntimeId("claude-cli")).toBe(true);
    expect(isCliRuntimeId("google-gemini-cli")).toBe(true);
    expect(isCliRuntimeId("codex-cli")).toBe(true);
    expect(isCliRuntimeId("codex")).toBe(false);
    expect(isCliRuntimeId("pi")).toBe(false);
  });

  it("only resolves CLI execution providers for compatible canonical providers", () => {
    expect(
      resolveCliRuntimeExecutionProvider({
        provider: "anthropic",
        runtimeOverride: "claude-cli",
      }),
    ).toBe("claude-cli");
    expect(
      resolveCliRuntimeExecutionProvider({
        provider: "openai",
        runtimeOverride: "claude-cli",
      }),
    ).toBeUndefined();
  });
});
