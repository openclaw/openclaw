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
  captureOperatorModelPolicySnapshot,
  prepareOperatorModelPolicy,
  readOperatorModelPolicyMembership,
  resolveOperatorModelDefault,
  restoreOperatorModelPolicySnapshot,
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
    {
      // A role ceiling must also exclude the model named by the wildcard's literal prefix.
      policy: { allow: ["vendor/*"], deny: ["vendor/restricted-v1*"] },
      checks: [
        ["vendor", ["restricted-v1", "restricted-v1-mini"], false],
        ["vendor", ["primary", "restricted-v2"], true],
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

it("reuses role policies within a publication and retires them on config or metadata changes", () => {
  const config = structuredClone(cfg);
  const role = { sourceAgent: "shared", allow: ["vendor/*"], deny: ["vendor/restricted-*"] };
  const deniedRole = { allow: [] };
  config.gateway = {
    roles: {
      default: "reader",
      definitions: {
        reader: { agents: "*", scopes: [], sessions: { others: "write" }, modelPolicy: role },
        denied: { agents: "*", scopes: [], sessions: { others: "write" }, modelPolicy: deniedRole },
      },
    },
  };
  const metadata = { owners: { modelIdNormalizationPolicies: new Map() } };
  const otherMetadata = { owners: { modelIdNormalizationPolicies: new Map() } };
  const prepare = (manifestPlugins = metadata) =>
    prepareOperatorModelPolicy({ cfg: config, policy: role, manifestPlugins })!;
  try {
    setRuntimeConfigSnapshot(config);
    const first = prepare();
    const denied = prepareOperatorModelPolicy({
      cfg: config,
      policy: deniedRole,
      manifestPlugins: metadata,
    });
    const other = prepare(otherMetadata);
    expect(prepare()).toBe(first);
    expect(denied?.models).toEqual([]);
    expect(
      prepareOperatorModelPolicy({ cfg: config, policy: deniedRole, manifestPlugins: metadata }),
    ).toBe(denied);
    expect(prepare(otherMetadata)).toBe(other);
    expect(other).not.toBe(first);
    expect(first.models).toEqual([
      { provider: "vendor", model: "primary" },
      { provider: "vendor", model: "fallback" },
    ]);
    expect(readOperatorModelPolicyMembership(first)).toBe(
      '[[],["vendor/*"],[],["vendor/restricted-*"]]',
    );
    role.deny = ["vendor/primary"];
    setRuntimeConfigSnapshot(config);
    const next = prepare();
    expect(next).not.toBe(first);
    expect(next.allows({ provider: "vendor", model: "primary" })).toBe(false);
    expect(first.allows({ provider: "vendor", model: "primary" })).toBe(true);
    clearRuntimeConfigSnapshot();
    role.deny = [];
    expect(prepare().allows({ provider: "vendor", model: "primary" })).toBe(true);
  } finally {
    clearRuntimeConfigSnapshot();
  }
});

it("captures immutable policy facts and isolates externally restored snapshots", () => {
  const prepared = prepareOperatorModelPolicy({
    cfg,
    policy: { allow: ["vendor/*"], deny: ["vendor/restricted-*"] },
    manifestPlugins: [],
  })!;
  const captured = captureOperatorModelPolicySnapshot(prepared)!;
  expect(Object.isFrozen(captured.models[0])).toBe(true);
  expect(Object.isFrozen(captured.allowed.wildcards)).toBe(true);
  const external = structuredClone(captured);
  const restored = restoreOperatorModelPolicySnapshot(external);
  external.models[0]!.model = "edited";
  external.allowed.wildcards.length = 0;
  external.denied.wildcards.length = 0;
  expect(restored.models).toEqual([
    { provider: "vendor", model: "primary" },
    { provider: "vendor", model: "fallback" },
  ]);
  expect(restored.allows({ provider: "vendor", model: "new" })).toBe(true);
  expect(restored.allows({ provider: "vendor", model: "restricted-new" })).toBe(false);
  expect(readOperatorModelPolicyMembership(restored)).toBe(
    '[[],["vendor/*"],[],["vendor/restricted-*"]]',
  );
  expect(Object.isFrozen(captureOperatorModelPolicySnapshot(restored)!.denied.wildcards)).toBe(
    true,
  );
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
  using aliases = vi.spyOn(modelSelection, "buildModelAliasIndex");

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
    const externalPolicy = { allow: ["vendor/*"] };
    const fromLivePolicy = () =>
      prepareOperatorModelPolicy({
        cfg: frozen,
        policy: externalPolicy,
        manifestPlugins: metadata,
      });
    expect(fromLivePolicy()?.allows({ provider: "vendor", model: "edited" })).toBe(true);
    externalPolicy.allow = [];
    expect(fromLivePolicy()?.models).toEqual([]);
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
