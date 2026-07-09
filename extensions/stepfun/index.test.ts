// Stepfun tests cover index plugin behavior.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import stepfunPlugin from "./index.js";
import {
  STEPFUN_DEFAULT_MODEL_REF,
  STEPFUN_PLAN_DEFAULT_MODEL_REF,
  buildStepFunPlanProvider,
  buildStepFunProvider,
} from "./provider-catalog.js";

type StepFunManifest = {
  setup?: {
    providers?: Array<{
      id?: string;
      authMethods?: string[];
      envVars?: string[];
    }>;
  };
  providerAuthChoices?: Array<{
    provider?: string;
    method?: string;
    choiceId?: string;
  }>;
};

function readManifest(): StepFunManifest {
  return JSON.parse(readFileSync(resolve(import.meta.dirname, "openclaw.plugin.json"), "utf-8"));
}

describe("stepfun provider registration", () => {
  it("adds Step 3.7 Flash without changing existing defaults", () => {
    const standard = buildStepFunProvider();
    const plan = buildStepFunPlanProvider();
    const standardModel = standard.models?.find((model) => model.id === "step-3.7-flash");
    const planModel = plan.models?.find((model) => model.id === "step-3.7-flash");

    expect(STEPFUN_DEFAULT_MODEL_REF).toBe("stepfun/step-3.5-flash");
    expect(STEPFUN_PLAN_DEFAULT_MODEL_REF).toBe("stepfun-plan/step-3.5-flash");
    expect(standardModel).toMatchObject({
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 262144,
      maxTokens: 262144,
      cost: { input: 0.2, output: 1.15, cacheRead: 0.04, cacheWrite: 0 },
    });
    expect(planModel).toMatchObject({
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 262144,
      maxTokens: 262144,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
  });

  it("keeps manifest auth choices aligned with runtime provider methods", async () => {
    const { providers } = await registerProviderPlugin({
      plugin: stepfunPlugin,
      id: "stepfun",
      name: "StepFun",
    });
    const manifest = readManifest();
    const runtimeChoices = ["stepfun", "stepfun-plan"].flatMap((providerId) => {
      const provider = requireRegisteredProvider(providers, providerId);
      return provider.auth.map((method) => ({
        provider: provider.id,
        method: method.id,
        choiceId: method.wizard?.choiceId,
      }));
    });

    const manifestChoices = manifest.providerAuthChoices?.map((choice) => ({
      provider: choice.provider,
      method: choice.method,
      choiceId: choice.choiceId,
    }));

    expect(runtimeChoices).toEqual(manifestChoices);
    expect(manifest.setup?.providers).toEqual([
      {
        id: "stepfun",
        envVars: ["STEPFUN_API_KEY"],
      },
      {
        id: "stepfun-plan",
        envVars: ["STEPFUN_API_KEY"],
      },
    ]);
  });
});
