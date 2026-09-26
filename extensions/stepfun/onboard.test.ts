import { buildModelAliasIndex, resolveModelRefFromString } from "openclaw/plugin-sdk/agent-runtime";
import { describe, expect, it } from "vitest";
import {
  applyStepFunPlanConfig,
  applyStepFunPlanConfigCn,
  applyStepFunStandardConfig,
  applyStepFunStandardConfigCn,
} from "./onboard.js";

describe.each([
  {
    name: "standard global",
    provider: "stepfun",
    apply: applyStepFunStandardConfig,
    rows: ["step-5-preview", "step-3.7-flash", "step-3.5-flash"],
  },
  {
    name: "standard China",
    provider: "stepfun",
    apply: applyStepFunStandardConfigCn,
    rows: ["step-5-preview", "step-3.7-flash", "step-3.5-flash"],
  },
  {
    name: "plan global",
    provider: "stepfun-plan",
    apply: applyStepFunPlanConfig,
    rows: ["step-5-preview", "step-3.7-flash", "step-3.5-flash", "step-3.5-flash-2603"],
  },
  {
    name: "plan China",
    provider: "stepfun-plan",
    apply: applyStepFunPlanConfigCn,
    rows: ["step-5-preview", "step-3.7-flash", "step-3.5-flash", "step-3.5-flash-2603"],
  },
])("StepFun $name setup", ({ provider, apply, rows }) => {
  it.each([undefined, "merge"] as const)(
    "leaves ordinary %s rows runtime-owned and retains aliases",
    (mode) => {
      const config = apply({ models: { mode } });

      expect(config.models?.providers?.[provider]?.models).toEqual([]);
      expect(config.agents?.defaults?.models?.[`${provider}/step-3.5-flash`]).toEqual({});
      expect(config.agents?.defaults?.models?.[`${provider}/step-5-preview`]?.alias).toBeDefined();
      expect(apply(config)).toEqual(config);
    },
  );

  it.each(["original", "padded", "lowercase"])(
    "preserves an existing %s alias through repeated setup and model resolution",
    (variant) => {
      const alias = provider === "stepfun" ? "StepFun" : "StepFun Plan";
      const existingAlias =
        variant === "padded"
          ? `  ${alias}  `
          : variant === "lowercase"
            ? alias.toLowerCase()
            : alias;
      const previousRef = `${provider}/step-3.5-flash`;
      const model = { primary: alias, fallbacks: [alias.toLowerCase()] };
      const config = apply({
        agents: { defaults: { model, models: { [previousRef]: { alias: existingAlias } } } },
      });
      expect(apply(config)).toEqual(config);
      expect(config.agents?.defaults?.model).toEqual(model);
      const aliasIndex = buildModelAliasIndex({ cfg: config, defaultProvider: provider });
      for (const raw of [model.primary, ...model.fallbacks]) {
        expect(
          resolveModelRefFromString({ raw, cfg: config, defaultProvider: provider, aliasIndex })
            ?.ref,
        ).toEqual({ provider, model: "step-3.5-flash" });
      }
    },
  );

  it("retains the shipped replace catalog", () => {
    const config = apply({ models: { mode: "replace" } });
    expect(config.models?.providers?.[provider]?.models.map((model) => model.id)).toEqual(rows);
  });
});
