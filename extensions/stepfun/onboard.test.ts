import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-onboard";
import { describe, expect, it } from "vitest";
import { applyStepFunPlanConfig, applyStepFunStandardConfig } from "./onboard.js";

function makeModel(id: string) {
  return {
    id,
    name: id,
    contextWindow: 4096,
    maxTokens: 1024,
    input: ["text"] as const,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
  };
}

describe("StepFun onboarding", () => {
  it("refreshes both StepFun surfaces and drops stale managed models for Step Plan", () => {
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          stepfun: {
            api: "openai-completions",
            baseUrl: "https://api.stepfun.ai/v1",
            models: [makeModel("step-3.5-flash-2603"), makeModel("custom-stepfun-model")],
          },
          "stepfun-plan": {
            api: "openai-completions",
            baseUrl: "https://api.stepfun.ai/step_plan/v1",
            models: [makeModel("step-3.5-flash")],
          },
        },
      },
    };

    const next = applyStepFunPlanConfig(cfg);

    expect(next.models?.providers?.stepfun?.baseUrl).toBe("https://api.stepfun.ai/v1");
    expect(next.models?.providers?.stepfun?.models?.map((model) => model.id).toSorted()).toEqual([
      "custom-stepfun-model",
      "step-3.5-flash",
    ]);
    expect(next.models?.providers?.["stepfun-plan"]?.baseUrl).toBe(
      "https://api.stepfun.ai/step_plan/v1",
    );
    expect(
      next.models?.providers?.["stepfun-plan"]?.models?.map((model) => model.id).toSorted(),
    ).toEqual(["step-3.5-flash", "step-3.5-flash-2603"]);
    expect(next.agents?.defaults?.model).toEqual({
      primary: "stepfun-plan/step-3.5-flash",
    });
  });

  it("keeps the standard catalog scoped to standard models while refreshing Step Plan", () => {
    const next = applyStepFunStandardConfig({});

    expect(next.models?.providers?.stepfun?.models?.map((model) => model.id)).toEqual([
      "step-3.5-flash",
    ]);
    expect(next.models?.providers?.["stepfun-plan"]?.models?.map((model) => model.id)).toEqual([
      "step-3.5-flash",
      "step-3.5-flash-2603",
    ]);
    expect(next.agents?.defaults?.model).toEqual({
      primary: "stepfun/step-3.5-flash",
    });
  });
});
