import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveToolLoopDetectionConfig } from "./pi-tools.js";

describe("resolveToolLoopDetectionConfig", () => {
  it("returns undefined by default for non-zai providers", () => {
    const resolved = resolveToolLoopDetectionConfig({
      provider: "anthropic",
      modelId: "claude-opus-4-6",
    });
    expect(resolved).toBeUndefined();
  });

  it("enables tighter defaults for zai glm models", () => {
    const resolved = resolveToolLoopDetectionConfig({
      provider: "z.ai",
      modelId: "glm-5",
    });
    expect(resolved).toMatchObject({
      enabled: true,
      historySize: 24,
      warningThreshold: 6,
      criticalThreshold: 10,
      globalCircuitBreakerThreshold: 14,
      detectors: {
        genericRepeat: true,
        knownPollNoProgress: true,
        pingPong: true,
      },
    });
  });

  it("merges configured values while filling missing zai glm defaults", () => {
    const cfg: OpenClawConfig = {
      tools: {
        loopDetection: {
          warningThreshold: 9,
          detectors: { pingPong: false },
        },
      },
    };
    const resolved = resolveToolLoopDetectionConfig({
      cfg,
      provider: "zai",
      modelId: "glm-5",
    });
    expect(resolved).toMatchObject({
      enabled: true,
      historySize: 24,
      warningThreshold: 9,
      criticalThreshold: 10,
      globalCircuitBreakerThreshold: 14,
      detectors: {
        genericRepeat: true,
        knownPollNoProgress: true,
        pingPong: false,
      },
    });
  });

  it("respects explicit enabled=false for zai glm configs", () => {
    const cfg: OpenClawConfig = {
      tools: {
        loopDetection: {
          enabled: false,
        },
      },
    };
    const resolved = resolveToolLoopDetectionConfig({
      cfg,
      provider: "z-ai",
      modelId: "glm-5",
    });
    expect(resolved?.enabled).toBe(false);
  });
});
