import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { resolveXAccount } from "./accounts.js";
import { XConfigSchema } from "./config-schema.js";

describe("X cost limit configuration", () => {
  it("resolves defaults and inherits individual limits through account overrides", () => {
    expect(resolveXAccount({}).costLimits).toEqual({
      dailyUsd: 100,
      monthlyUsd: 1_000,
      cycleStartDay: 1,
    });
    const cfg: OpenClawConfig = {
      channels: {
        x: {
          costLimits: { dailyUsd: 30, monthlyUsd: 300, cycleStartDay: 20 },
          accounts: {
            team: { costLimits: { dailyUsd: 5 } },
            paused: { costLimits: { dailyUsd: 0 } },
          },
        },
      },
    };
    expect(resolveXAccount(cfg, "team").costLimits).toEqual({
      dailyUsd: 5,
      monthlyUsd: 300,
      cycleStartDay: 20,
    });
    expect(resolveXAccount(cfg, "paused").costLimits.dailyUsd).toBe(0);
    expect(XConfigSchema.safeParse(cfg.channels?.x).success).toBe(true);
  });

  it.each([
    { dailyUsd: -1 },
    { monthlyUsd: -1 },
    { dailyUsd: Number.POSITIVE_INFINITY },
    { monthlyUsd: Number.NaN },
    { cycleStartDay: 0 },
    { cycleStartDay: 29 },
    { cycleStartDay: 1.5 },
  ])("rejects invalid root and account limits: %j", (costLimits) => {
    expect(XConfigSchema.safeParse({ costLimits }).success).toBe(false);
    expect(XConfigSchema.safeParse({ accounts: { team: { costLimits } } }).success).toBe(false);
  });
});

describe("X public work-session configuration", () => {
  it("preserves account opt-outs from the shared publication default", () => {
    const cfg: OpenClawConfig = {
      channels: {
        x: {
          autoPublishWorkSessions: true,
          accounts: { inherited: {}, private: { autoPublishWorkSessions: false } },
        },
      },
    };
    expect(XConfigSchema.safeParse(cfg.channels?.x).success).toBe(true);
    expect(resolveXAccount(cfg, "inherited").config.autoPublishWorkSessions).toBe(true);
    expect(resolveXAccount(cfg, "private").config.autoPublishWorkSessions).toBe(false);
    expect(resolveXAccount({}).config.autoPublishWorkSessions).toBeUndefined();
  });
});
