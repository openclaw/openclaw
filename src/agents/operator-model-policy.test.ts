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
  it("derives ordered choices from the designated agent and resolves its aliases before exclusions", () => {
    const cfg = config();
    const policy = prepareOperatorModelPolicy({
      cfg,
      policy: { deny: ["vendor/restricted-*"] },
      manifestPlugins: [],
    })!;
    expect(policy.models).toEqual([
      { provider: "vendor", model: "primary" },
      { provider: "vendor", model: "fallback" },
    ]);
    expect(policy.allows({ provider: "vendor", model: "unrelated" })).toBe(false);
    expect(policy.allows({ provider: "vendor", model: "global" })).toBe(false);
    expect(policy.allows({ provider: "vendor", model: "restricted-v1" })).toBe(false);
    expect(policy.allows({ provider: "vendor", model: "vendor/primary" })).toBe(false);

    const deniedAlias = prepareOperatorModelPolicy({
      cfg,
      policy: { sourceAgent: "shared", deny: ["fast"] },
      manifestPlugins: [],
    })!;
    expect(deniedAlias.allows({ provider: "vendor", model: "fallback" })).toBe(false);
  });

  it("keeps family exclusions effective when the referenced source adds new models", () => {
    const cfg = config();
    cfg.agents!.entries!.shared!.model = {
      primary: "vendor/restricted-next",
      fallbacks: ["vendor/fallback", "vendor/new-allowed"],
    };
    const after = prepareOperatorModelPolicy({
      cfg,
      policy: { deny: ["vendor/restricted-*"] },
      manifestPlugins: [],
    })!;
    expect(after.models).toEqual([
      { provider: "vendor", model: "fallback" },
      { provider: "vendor", model: "new-allowed" },
    ]);
    expect(after.allows({ provider: "vendor", model: "restricted-next" })).toBe(false);
  });

  it("supports explicit membership and provider-normalized exclusions without widening empty policies", () => {
    const cfg = config();
    const policy = prepareOperatorModelPolicy({
      cfg,
      policy: { allow: ["vendor/*", "second/manual"], deny: [" VENDOR / restricted-* "] },
      manifestPlugins: [],
    })!;
    expect(policy.allows({ provider: "VENDOR", model: "new" })).toBe(true);
    expect(policy.allows({ provider: "vendor", model: "restricted-new" })).toBe(false);
    expect(policy.allows({ provider: "second", model: "manual" })).toBe(true);
    expect(policy.allows({ provider: "second", model: "other" })).toBe(false);
    expect(
      prepareOperatorModelPolicy({ cfg, policy: undefined, manifestPlugins: [] }),
    ).toBeUndefined();
    const empty = prepareOperatorModelPolicy({ cfg, policy: { allow: [] }, manifestPlugins: [] })!;
    expect(empty.models).toEqual([]);
    expect(empty.allows({ provider: "vendor", model: "primary" })).toBe(false);
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
