import { describe, expect, it } from "vitest";
import { ROUTER_DEFAULTS } from "./config.js";
import { isRejection, resolve } from "./resolver.js";

describe("aj-router resolver", () => {
  it("routes a short classification prompt to the speed alias", () => {
    const result = resolve({
      config: ROUTER_DEFAULTS,
      prompt: "Classify this email as spam or not.",
    });
    expect(isRejection(result)).toBe(false);
    if (!isRejection(result)) {
      expect(result.alias).toBe("speed");
      expect(result.modelRef).toBe("anthropic/claude-haiku-4-5");
    }
  });

  it("routes a medium-length generic prompt to the workhorse alias", () => {
    const result = resolve({
      config: ROUTER_DEFAULTS,
      prompt:
        "Draft a one-page memo for tomorrow's ops meeting covering Q2 priorities, dependencies, and the agenda so the team arrives informed.",
    });
    expect(isRejection(result)).toBe(false);
    if (!isRejection(result)) {
      expect(result.alias).toBe("workhorse");
    }
  });

  it("routes a complex architecture prompt to the flagship alias", () => {
    const result = resolve({
      config: ROUTER_DEFAULTS,
      prompt: "Design a multi-agent orchestration architecture.",
    });
    expect(isRejection(result)).toBe(false);
    if (!isRejection(result)) {
      expect(result.alias).toBe("flagship");
    }
  });

  it("escalates low-confidence simple prompts one tier up", () => {
    const result = resolve({
      config: ROUTER_DEFAULTS,
      prompt: "hmm?",
    });
    expect(isRejection(result)).toBe(false);
    if (!isRejection(result)) {
      expect(result.escalated).toBe(true);
      expect(result.alias).toBe("workhorse");
    }
  });

  it("rejects privileged requests whose forced alias is not a local provider", () => {
    const result = resolve({
      config: ROUTER_DEFAULTS,
      prompt: "Classify this.",
      sensitivity: "privileged",
    });
    expect(isRejection(result)).toBe(true);
  });

  it("honors a caller-supplied classification override", () => {
    const result = resolve({
      config: ROUTER_DEFAULTS,
      prompt: "anything",
      classificationOverride: {
        tier: "complex",
        confidence: 0.95,
        reason: "test override",
      },
    });
    expect(isRejection(result)).toBe(false);
    if (!isRejection(result)) {
      expect(result.alias).toBe("flagship");
      expect(result.escalated).toBe(false);
    }
  });
});
