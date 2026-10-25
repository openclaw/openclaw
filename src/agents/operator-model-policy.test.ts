import { expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";
import type { ModelManifestNormalizationContext } from "./model-ref-shared.js";
import * as modelSelection from "./model-selection-shared.js";
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

it("shares agent selection work across interleaved roles, agents, and metadata generations", () => {
  const config = freezeJsonSnapshot(structuredClone(cfg));
  const metadata: ModelManifestNormalizationContext["manifestPlugins"] = {
    owners: { modelIdNormalizationPolicies: new Map() },
  };
  const scopedMetadata: ModelManifestNormalizationContext["manifestPlugins"] = {
    owners: {
      modelIdNormalizationPolicies: new Map([["vendor", { prefixWhenBare: "scoped" }]]),
    },
  };
  const aliases = vi.spyOn(modelSelection, "buildModelAliasIndex");
  try {
    const prepare = (sourceAgent: string, manifestPlugins = metadata, deny: string[] = []) =>
      prepareOperatorModelPolicy({ cfg: config, policy: { sourceAgent, deny }, manifestPlugins });
    expect(prepare("shared")?.models.map((ref) => ref.model)).toEqual([
      "primary",
      "fallback",
      "restricted-v1",
    ]);
    expect(prepare("other")?.models).toEqual([{ provider: "vendor", model: "other" }]);
    expect(prepare("shared", scopedMetadata)?.models[0]?.model).toBe("scoped/primary");
    expect(
      prepare("shared", metadata, ["fast"])?.allows({ provider: "vendor", model: "fallback" }),
    ).toBe(false);
    expect(prepare("other")?.models).toEqual([{ provider: "vendor", model: "other" }]);
    expect(prepare("shared", scopedMetadata)?.models[0]?.model).toBe("scoped/primary");
    const replacement = freezeJsonSnapshot<OpenClawConfig>({
      agents: { entries: { shared: { model: "vendor/replacement" } } },
    });
    expect(
      prepareOperatorModelPolicy({
        cfg: replacement,
        policy: { sourceAgent: "shared" },
        manifestPlugins: metadata,
      })?.models,
    ).toEqual([{ provider: "vendor", model: "replacement" }]);
    expect(prepare("shared")?.models[0]?.model).toBe("primary");
    expect(aliases).toHaveBeenCalledTimes(4);
  } finally {
    aliases.mockRestore();
  }
});

it("refreshes same-object config publications and keeps unowned mutable inputs live", () => {
  const config = structuredClone(cfg);
  const metadata = { owners: { modelIdNormalizationPolicies: new Map() } };
  const prepare = () =>
    prepareOperatorModelPolicy({ cfg: config, policy: {}, manifestPlugins: metadata });
  const changePrimary = (model: string) => {
    config.agents!.entries!.shared!.model = { primary: model, fallbacks: ["fast"] };
  };
  try {
    setRuntimeConfigSnapshot(config);
    expect(prepare()?.models[0]?.model).toBe("primary");
    changePrimary("vendor/published");
    setRuntimeConfigSnapshot(config);
    expect(prepare()?.models[0]?.model).toBe("published");
    clearRuntimeConfigSnapshot();
    changePrimary("vendor/unpublished");
    expect(prepare()?.models[0]?.model).toBe("unpublished");
    changePrimary("vendor/edited");
    expect(prepare()?.models[0]?.model).toBe("edited");
    const frozen = freezeJsonSnapshot(structuredClone(config));
    const manifestPlugins = [
      { modelIdNormalization: { providers: { vendor: { prefixWhenBare: "one" } } } },
    ];
    const fromLiveArray = () =>
      prepareOperatorModelPolicy({ cfg: frozen, policy: {}, manifestPlugins });
    expect(fromLiveArray()?.models[0]?.model).toBe("one/edited");
    manifestPlugins[0]!.modelIdNormalization.providers.vendor.prefixWhenBare = "two";
    expect(fromLiveArray()?.models[0]?.model).toBe("two/edited");
  } finally {
    clearRuntimeConfigSnapshot();
  }
});
