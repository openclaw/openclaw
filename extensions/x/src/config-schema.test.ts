import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createResolverContext } from "openclaw/plugin-sdk/secret-ref-runtime";
import { describe, expect, it } from "vitest";
import { resolveXAccount } from "./accounts.js";
import { XConfigSchema } from "./config-schema.js";
import { channelSecrets } from "./secret-contract.js";

describe("X GitHub verification configuration", () => {
  it("is off by default and inherits individual GitHub settings through account overrides", () => {
    expect(resolveXAccount({}).config.verifiedFromGitHub).toBeUndefined();
    const token = { source: "env", provider: "default", id: "X_GITHUB_TOKEN" } as const;
    const cfg: OpenClawConfig = {
      channels: {
        x: {
          verifiedFromGitHub: { repo: "openclaw/openclaw", refreshMinutes: 60, token },
          accounts: { team: { verifiedFromGitHub: { minPermission: "maintain" } } },
        },
      },
    };
    expect(XConfigSchema.safeParse(cfg.channels?.x).success).toBe(true);
    expect(resolveXAccount(cfg, "team").config.verifiedFromGitHub).toEqual({
      repo: "openclaw/openclaw",
      minPermission: "maintain",
      refreshMinutes: 60,
      token,
    });
  });

  it.each([
    { repo: "https://github.com/openclaw/openclaw" },
    { repo: "openclaw" },
    { repo: "openclaw/../other" },
    { repo: "openclaw/.." },
    { minPermission: "pull" },
    { refreshMinutes: 14 },
    { refreshMinutes: 15.5 },
  ])("rejects invalid GitHub settings at root and account scope: %j", (verifiedFromGitHub) => {
    expect(XConfigSchema.safeParse({ verifiedFromGitHub }).success).toBe(false);
    expect(XConfigSchema.safeParse({ accounts: { team: { verifiedFromGitHub } } }).success).toBe(
      false,
    );
  });

  it("resolves only active GitHub token owners, including inherited nested settings", () => {
    const token = { source: "env", provider: "default", id: "X_GITHUB_TOKEN" } as const;
    const config = {
      channels: {
        x: {
          verifiedFromGitHub: { token },
          accounts: {
            team: { verifiedFromGitHub: { repo: "openclaw/openclaw" } },
            own: {
              verifiedFromGitHub: {
                repo: "example/repo",
                token: { ...token, id: "OWN_GITHUB_TOKEN" },
              },
            },
            disabled: { enabled: false, verifiedFromGitHub: { repo: "example/repo", token } },
            unconfigured: { verifiedFromGitHub: { token } },
          },
        },
      },
    };
    const context = createResolverContext({ sourceConfig: config, env: {} });
    channelSecrets.collectRuntimeConfigAssignments({ config, context });
    expect(context.assignments.map(({ path, ownerId }) => ({ path, ownerId }))).toEqual([
      { path: "channels.x.verifiedFromGitHub.token", ownerId: "x:team" },
      { path: "channels.x.accounts.own.verifiedFromGitHub.token", ownerId: "x:own" },
    ]);
    context.assignments[0]?.apply("resolved-shared-token");
    context.assignments[1]?.apply("resolved-own-token");
    expect(resolveXAccount(config, "team").config.verifiedFromGitHub?.token).toBe(
      "resolved-shared-token",
    );
    expect(resolveXAccount(config, "own").config.verifiedFromGitHub?.token).toBe(
      "resolved-own-token",
    );
  });
});

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
