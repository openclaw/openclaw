import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveToolLoopDetectionConfig } from "./pi-tools.js";

/**
 * Heartbeat runs are the canonical \"unbounded loop\" failure surface for
 * tool-calling models that emit pseudo-final tokens (`HEARTBEAT_OK`,
 * `NO_REPLY`) in the same response as tool calls.  Issue #21597 documents a
 * heartbeat-only session burning 47 million assistant tokens in one day
 * because the agent kept calling tools instead of terminating.
 *
 * The existing {@link detectToolCallLoop} framework already handles this
 * once enabled, but `tools.loopDetection.enabled` defaults to `false`, which
 * means by default a heartbeat tick is unprotected.  These tests pin the
 * heartbeat-trigger override behavior in {@link resolveToolLoopDetectionConfig}.
 */
describe("resolveToolLoopDetectionConfig (heartbeat trigger override)", () => {
  it("returns undefined for a non-heartbeat run with no config (no change in behavior)", () => {
    const result = resolveToolLoopDetectionConfig({});
    expect(result).toBeUndefined();
  });

  it("enables loop detection for heartbeat runs when the user has not configured it", () => {
    const result = resolveToolLoopDetectionConfig({ trigger: "heartbeat" });
    expect(result).toBeDefined();
    expect(result?.enabled).toBe(true);
  });

  it("uses default thresholds when heartbeat enables loop detection implicitly", () => {
    const result = resolveToolLoopDetectionConfig({ trigger: "heartbeat" });
    // The override only flips `enabled`; thresholds stay at the
    // resolveLoopDetectionConfig defaults so behavior remains predictable.
    expect(result).toEqual({ enabled: true });
  });

  it("respects an explicit user opt-out even on heartbeat runs", () => {
    // If the user has gone out of their way to set loopDetection.enabled = false
    // we honor that — heartbeat should not silently override an explicit choice.
    const cfg: OpenClawConfig = {
      tools: { loopDetection: { enabled: false } },
    } as OpenClawConfig;
    const result = resolveToolLoopDetectionConfig({ cfg, trigger: "heartbeat" });
    expect(result?.enabled).toBe(false);
  });

  it("respects an explicit user opt-in and preserves their thresholds", () => {
    const cfg: OpenClawConfig = {
      tools: {
        loopDetection: {
          enabled: true,
          warningThreshold: 5,
          criticalThreshold: 12,
        },
      },
    } as OpenClawConfig;
    const result = resolveToolLoopDetectionConfig({ cfg, trigger: "heartbeat" });
    expect(result).toEqual({
      enabled: true,
      warningThreshold: 5,
      criticalThreshold: 12,
    });
  });

  it("does not enable loop detection for non-heartbeat triggers", () => {
    // Cron / user / memory triggers keep the existing opt-in behavior — we
    // only relax the default for the heartbeat path because that is the
    // documented failure mode in #21597.
    for (const trigger of ["user", "cron", "memory", "manual", undefined]) {
      const result = resolveToolLoopDetectionConfig({ trigger });
      expect(result?.enabled, `trigger=${trigger ?? "undefined"}`).toBeUndefined();
    }
  });

  it("merges agent-scoped config with global config before applying the heartbeat default", () => {
    // Ensures the heartbeat override does not bypass the existing agent/global
    // merge.  The override only inspects `enabled` after the merge.
    const cfg: OpenClawConfig = {
      tools: {
        loopDetection: {
          historySize: 50,
          detectors: { genericRepeat: true, knownPollNoProgress: false, pingPong: true },
        },
      },
      agents: {
        list: [
          {
            id: "amber",
            tools: {
              loopDetection: {
                warningThreshold: 7,
                detectors: { knownPollNoProgress: true },
              },
            },
          },
        ],
      },
    } as unknown as OpenClawConfig;

    const result = resolveToolLoopDetectionConfig({
      cfg,
      agentId: "amber",
      trigger: "heartbeat",
    });

    // Heartbeat default flipped enabled to true...
    expect(result?.enabled).toBe(true);
    // ...without dropping the merged user values.
    expect(result?.historySize).toBe(50);
    expect(result?.warningThreshold).toBe(7);
    expect(result?.detectors).toEqual({
      genericRepeat: true,
      knownPollNoProgress: true,
      pingPong: true,
    });
  });
});
