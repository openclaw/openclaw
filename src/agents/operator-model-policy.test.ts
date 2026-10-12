import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  prepareOperatorModelPolicy,
  resolveOperatorModelDefault,
} from "./operator-model-policy.js";

function config(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        systemAgent: { agentId: "shared" },
        model: "vendor/global",
        models: { "vendor/unrelated": { alias: "fast" } },
      },
      entries: {
        shared: {
          model: {
            primary: "vendor/primary",
            fallbacks: ["fast", "vendor/restricted-v1", "vendor/fallback"],
          },
          models: { "vendor/fallback": { alias: "fast" } },
        },
        other: { model: "vendor/other" },
      },
    },
  };
}

describe("operator model policy", () => {
  it("derives membership from source models, aliases, wildcards, and explicit empty policies", () => {
    const cases: Array<{
      policy: Parameters<typeof prepareOperatorModelPolicy>[0]["policy"];
      models?: Array<{ provider: string; model: string }>;
      checks: Array<[provider: string, model: string, allowed: boolean]>;
    }> = [
      {
        policy: { deny: ["vendor/restricted-*"] },
        models: [
          { provider: "vendor", model: "primary" },
          { provider: "vendor", model: "fallback" },
        ],
        checks: [
          ["vendor", "unrelated", false],
          ["vendor", "global", false],
          ["vendor", "restricted-v1", false],
          ["vendor", "vendor/primary", false],
        ],
      },
      {
        policy: { sourceAgent: "shared", deny: ["fast"] },
        checks: [["vendor", "fallback", false]],
      },
      {
        policy: { allow: ["vendor/*", "second/manual"], deny: [" VENDOR / restricted-* "] },
        checks: [
          ["VENDOR", "new", true],
          ["vendor", "restricted-new", false],
          ["second", "manual", true],
          ["second", "other", false],
        ],
      },
      { policy: undefined, checks: [] },
      { policy: { allow: [] }, models: [], checks: [["vendor", "primary", false]] },
    ];
    const cfg = config();
    for (const row of cases) {
      const policy = prepareOperatorModelPolicy({ cfg, policy: row.policy, manifestPlugins: [] });
      if (!row.policy) {
        expect(policy).toBeUndefined();
        continue;
      }
      if (row.models) {
        expect(policy!.models).toEqual(row.models);
      }
      for (const [provider, model, allowed] of row.checks) {
        expect(policy!.allows({ provider, model }), `${provider}/${model}`).toBe(allowed);
      }
    }
  });

  it("replaces a denied default with an existing automatic fallback without granting a manual override", () => {
    const cfg = config();
    const policy = prepareOperatorModelPolicy({
      cfg,
      policy: { deny: ["vendor/primary", "vendor/restricted-*"] },
      manifestPlugins: [],
    });
    expect(
      resolveOperatorModelDefault({
        cfg,
        agentId: "shared",
        policy,
        model: { provider: "vendor", model: "primary" },
        allows: () => false,
        manifestPlugins: [],
      }),
    ).toEqual({ provider: "vendor", model: "fallback" });
    expect(
      resolveOperatorModelDefault({
        cfg,
        agentId: "other",
        policy,
        model: { provider: "vendor", model: "other" },
        allows: () => false,
        manifestPlugins: [],
      }),
    ).toBeUndefined();
  });
});
