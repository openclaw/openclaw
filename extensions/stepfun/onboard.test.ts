import { describe, expect, it } from "vitest";
import { applyStepFunPlanConfigCn, applyStepFunStandardConfig } from "./onboard.js";

describe.each([
  ["stepfun", applyStepFunStandardConfig, undefined, ["step-3.7-flash", "step-3.5-flash"]],
  [
    "stepfun-plan",
    applyStepFunPlanConfigCn,
    "merge",
    ["step-3.7-flash", "step-3.5-flash", "step-3.5-flash-2603"],
  ],
] as const)("%s setup", (provider, apply, mode, rows) => {
  it("leaves ordinary rows runtime-owned and retains aliases", () => {
    const config = apply({ models: { mode } });

    expect(config.models?.providers?.[provider]?.models).toEqual([]);
    expect(config.agents?.defaults?.models?.[`${provider}/step-3.7-flash`]).toEqual({});
    expect(config.agents?.defaults?.models?.[`${provider}/step-3.5-flash`]?.alias).toBeDefined();
    expect(apply(config)).toEqual(config);
  });

  it("retains the shipped replace catalog", () => {
    const config = apply({ models: { mode: "replace" } });
    expect(config.models?.providers?.[provider]?.models.map((model) => model.id)).toEqual(rows);
  });
});
