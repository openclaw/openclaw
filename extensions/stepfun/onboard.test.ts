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
      expect(config.agents?.defaults?.models?.[`${provider}/step-3.7-flash`]).toEqual({});
      expect(config.agents?.defaults?.models?.[`${provider}/step-3.5-flash`]).toEqual({});
      expect(config.agents?.defaults?.models?.[`${provider}/step-5-preview`]?.alias).toBeDefined();
      expect(apply(config)).toEqual(config);
    },
  );

  it("retains the shipped replace catalog", () => {
    const config = apply({ models: { mode: "replace" } });
    expect(config.models?.providers?.[provider]?.models.map((model) => model.id)).toEqual(rows);
  });
});

describe.each([
  {
    name: "standard global",
    apply: applyStepFunStandardConfig,
    provider: "stepfun",
    alias: "StepFun",
  },
  {
    name: "standard China",
    apply: applyStepFunStandardConfigCn,
    provider: "stepfun",
    alias: "StepFun",
  },
  {
    name: "plan global",
    apply: applyStepFunPlanConfig,
    provider: "stepfun-plan",
    alias: "StepFun Plan",
  },
  {
    name: "plan China",
    apply: applyStepFunPlanConfigCn,
    provider: "stepfun-plan",
    alias: "StepFun Plan",
  },
])("StepFun $name re-onboarding", ({ apply, provider, alias }) => {
  it("keeps an existing alias on the model it already owned instead of the new default", () => {
    // Config as a prior onboarding run wrote it, when step-3.5-flash was the default.
    const priorRef = `${provider}/step-3.5-flash`;
    const upgraded = apply({
      agents: { defaults: { model: priorRef, models: { [priorRef]: { alias } } } },
    });
    const models = upgraded.agents?.defaults?.models ?? {};

    // The alias stays on the model the user was already using...
    expect(models[priorRef]?.alias).toBe(alias);
    // ...and the new default does not silently steal it.
    expect(models[`${provider}/step-5-preview`]?.alias).toBeUndefined();
    // The explicit primary is left untouched.
    expect(upgraded.agents?.defaults?.model).toBe(priorRef);
  });

  it("keeps an existing alias whose padding only the runtime normalizes", () => {
    // Runtime alias keys are trimmed + lowercased, so " StepFun " and "StepFun"
    // resolve to the same alias. The ownership guard must normalize the same way,
    // otherwise the padded alias looks unowned and the new default steals lookup.
    const priorRef = `${provider}/step-3.5-flash`;
    const paddedAlias = ` ${alias} `;
    const upgraded = apply({
      agents: { defaults: { model: priorRef, models: { [priorRef]: { alias: paddedAlias } } } },
    });
    const models = upgraded.agents?.defaults?.models ?? {};

    expect(models[priorRef]?.alias).toBe(paddedAlias);
    expect(models[`${provider}/step-5-preview`]?.alias).toBeUndefined();
    expect(upgraded.agents?.defaults?.model).toBe(priorRef);
  });

  it("binds the alias to step-5-preview on a fresh install", () => {
    const fresh = apply({});
    expect(fresh.agents?.defaults?.models?.[`${provider}/step-5-preview`]?.alias).toBe(alias);
  });
});
