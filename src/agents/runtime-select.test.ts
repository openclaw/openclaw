import { afterEach, describe, expect, it } from "vitest";
import { resolveAgentRuntime } from "./runtime-select.js";

describe("resolveAgentRuntime", () => {
  const originalEnv = process.env.OPENCLAW_RUNTIME;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.OPENCLAW_RUNTIME;
    } else {
      process.env.OPENCLAW_RUNTIME = originalEnv;
    }
  });

  it("defaults to pi when env is unset", () => {
    delete process.env.OPENCLAW_RUNTIME;
    expect(resolveAgentRuntime()).toBe("pi");
  });

  it('returns copilot when env is "copilot"', () => {
    process.env.OPENCLAW_RUNTIME = "copilot";
    expect(resolveAgentRuntime()).toBe("copilot");
  });

  it('returns copilot when env is "copilot-sdk"', () => {
    process.env.OPENCLAW_RUNTIME = "copilot-sdk";
    expect(resolveAgentRuntime()).toBe("copilot");
  });

  it("is case-insensitive", () => {
    process.env.OPENCLAW_RUNTIME = "COPILOT";
    expect(resolveAgentRuntime()).toBe("copilot");
  });

  it("trims whitespace", () => {
    process.env.OPENCLAW_RUNTIME = "  copilot  ";
    expect(resolveAgentRuntime()).toBe("copilot");
  });

  it("falls back to pi for unknown values", () => {
    process.env.OPENCLAW_RUNTIME = "something-else";
    expect(resolveAgentRuntime()).toBe("pi");
  });
});
