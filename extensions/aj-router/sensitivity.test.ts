import { describe, expect, it } from "vitest";
import { ROUTER_DEFAULTS } from "./config.js";
import { evaluate } from "./sensitivity.js";

function withConfig(overrides: Partial<typeof ROUTER_DEFAULTS> = {}) {
  return { ...ROUTER_DEFAULTS, ...overrides };
}

describe("aj-router sensitivity gate", () => {
  it("allows public requests to any provider", () => {
    const decision = evaluate({
      config: withConfig(),
      sensitivity: "public",
      candidateModelRef: "openai/gpt-5.4",
    });
    expect(decision).toEqual({ kind: "allow" });
  });

  it("allows internal requests to anthropic/openai/google", () => {
    const decision = evaluate({
      config: withConfig(),
      sensitivity: "internal",
      candidateModelRef: "anthropic/claude-sonnet-4-6",
    });
    expect(decision).toEqual({ kind: "allow" });
  });

  it("rejects confidential requests targeting non-anthropic providers", () => {
    const decision = evaluate({
      config: withConfig(),
      sensitivity: "confidential",
      candidateModelRef: "openai/gpt-5.4",
    });
    expect(decision.kind).toBe("reject");
  });

  it("forces privileged requests to the configured privileged alias", () => {
    const config = withConfig({
      aliases: {
        ...ROUTER_DEFAULTS.aliases,
        privileged: "ollama/llama3.3:8b",
      },
    });
    const decision = evaluate({
      config,
      sensitivity: "privileged",
      candidateModelRef: "anthropic/claude-sonnet-4-6",
    });
    expect(decision.kind).toBe("force-alias");
    if (decision.kind === "force-alias") {
      expect(decision.alias).toBe("privileged");
    }
  });

  it("rejects privileged requests when forced alias points at an external provider", () => {
    // Default has privileged → anthropic/... with blockExternal=true. Reject.
    const decision = evaluate({
      config: withConfig(),
      sensitivity: "privileged",
      candidateModelRef: "anthropic/claude-sonnet-4-6",
    });
    expect(decision.kind).toBe("reject");
  });

  it("falls back to default sensitivity when unspecified", () => {
    // Default = "internal"; openai is allowed.
    const decision = evaluate({
      config: withConfig(),
      sensitivity: undefined,
      candidateModelRef: "openai/gpt-5.4",
    });
    expect(decision.kind).toBe("allow");
  });
});
