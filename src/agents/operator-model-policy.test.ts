import { expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  prepareOperatorModelPolicy,
  resolveOperatorModelDefault,
} from "./operator-model-policy.js";

const cfg: OpenClawConfig = {
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

it("derives membership from source models, aliases, wildcards, and explicit empty policies", () => {
  const cases: Array<{
    policy: Parameters<typeof prepareOperatorModelPolicy>[0]["policy"];
    models?: string[];
    checks: Array<[provider: string, models: string[], allowed: boolean]>;
  }> = [
    {
      policy: { deny: ["vendor/restricted-*"] },
      models: ["primary", "fallback"],
      checks: [["vendor", ["unrelated", "global", "restricted-v1", "vendor/primary"], false]],
    },
    {
      policy: { sourceAgent: "shared", deny: ["fast"] },
      checks: [["vendor", ["fallback"], false]],
    },
    {
      policy: { allow: ["vendor/*", "second/manual"], deny: [" VENDOR / restricted-* "] },
      checks: [
        ["VENDOR", ["new"], true],
        ["vendor", ["restricted-new"], false],
        ["second", ["manual"], true],
        ["second", ["other"], false],
      ],
    },
    { policy: undefined, checks: [] },
    { policy: { allow: [] }, models: [], checks: [["vendor", ["primary"], false]] },
  ];
  for (const row of cases) {
    const policy = prepareOperatorModelPolicy({ cfg, policy: row.policy, manifestPlugins: [] });
    if (!row.policy) {
      expect(policy).toBeUndefined();
      continue;
    }
    if (row.models) {
      expect(policy!.models).toEqual(row.models.map((model) => ({ provider: "vendor", model })));
    }
    for (const [provider, models, allowed] of row.checks) {
      for (const model of models) {
        expect(policy!.allows({ provider, model }), `${provider}/${model}`).toBe(allowed);
      }
    }
  }
});

it("replaces a denied default with an existing automatic fallback without granting a manual override", () => {
  const denied = ["vendor/primary", "vendor/restricted-*"];
  const policy = prepareOperatorModelPolicy({ cfg, policy: { deny: denied }, manifestPlugins: [] });
  const defaults = { cfg, policy, allows: () => false, manifestPlugins: [] };
  const resolve = (agentId: string, model: string) =>
    resolveOperatorModelDefault({ ...defaults, agentId, model: { provider: "vendor", model } });
  expect(resolve("shared", "primary")).toEqual({ provider: "vendor", model: "fallback" });
  expect(resolve("other", "other")).toBeUndefined();
});
