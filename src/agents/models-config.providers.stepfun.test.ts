import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { upsertAuthProfile } from "./auth-profiles.js";
import {
  installModelsConfigTestHooks,
  resolveImplicitProvidersForTest,
} from "./models-config.e2e-harness.js";

const EXPECTED_STANDARD_MODELS = ["step-3.5-flash"];
const EXPECTED_PLAN_MODELS = ["step-3.5-flash", "step-3.5-flash-2603"];

installModelsConfigTestHooks();

describe("StepFun provider catalog", () => {
  it("includes standard and Step Plan providers when STEPFUN_API_KEY is configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const providers = await resolveImplicitProvidersForTest({
      agentDir,
      env: { STEPFUN_API_KEY: "test-stepfun-key" },
    });
    const standardProvider = providers?.stepfun;
    const planProvider = providers?.["stepfun-plan"];

    expect(standardProvider).toMatchObject({
      baseUrl: "https://api.stepfun.ai/v1",
      api: "openai-completions",
      apiKey: "STEPFUN_API_KEY",
    });
    expect(planProvider).toMatchObject({
      baseUrl: "https://api.stepfun.ai/step_plan/v1",
      api: "openai-completions",
      apiKey: "STEPFUN_API_KEY",
    });
    expect(standardProvider.models?.map((model) => model.id)).toEqual(EXPECTED_STANDARD_MODELS);
    expect(planProvider.models?.map((model) => model.id)).toEqual(EXPECTED_PLAN_MODELS);
  });

  it("falls back to global endpoints for untagged StepFun auth profiles", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));

    upsertAuthProfile({
      profileId: "stepfun:default",
      credential: {
        type: "api_key",
        provider: "stepfun",
        key: "sk-stepfun-default", // pragma: allowlist secret
      },
      agentDir,
    });
    upsertAuthProfile({
      profileId: "stepfun-plan:default",
      credential: {
        type: "api_key",
        provider: "stepfun-plan",
        key: "sk-stepfun-default", // pragma: allowlist secret
      },
      agentDir,
    });

    const providers = await resolveImplicitProvidersForTest({ agentDir, env: {} });

    expect(providers?.stepfun?.baseUrl).toBe("https://api.stepfun.ai/v1");
    expect(providers?.["stepfun-plan"]?.baseUrl).toBe("https://api.stepfun.ai/step_plan/v1");
    expect(providers?.stepfun?.models?.map((model) => model.id)).toEqual(EXPECTED_STANDARD_MODELS);
    expect(providers?.["stepfun-plan"]?.models?.map((model) => model.id)).toEqual(
      EXPECTED_PLAN_MODELS,
    );
  });

  it("uses China endpoints when explicit config points the paired surface at the China host", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const providers = await resolveImplicitProvidersForTest({
      agentDir,
      env: { STEPFUN_API_KEY: "test-stepfun-key" },
      config: {
        models: {
          providers: {
            "stepfun-plan": {
              baseUrl: "https://api.stepfun.com/step_plan/v1",
              models: [],
            },
          },
        },
      },
    });

    expect(providers?.stepfun?.baseUrl).toBe("https://api.stepfun.com/v1");
    expect(providers?.["stepfun-plan"]?.baseUrl).toBe("https://api.stepfun.com/step_plan/v1");
  });

  it("discovers both providers from shared regional auth profiles", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));

    upsertAuthProfile({
      profileId: "stepfun:cn",
      credential: {
        type: "api_key",
        provider: "stepfun",
        key: "sk-stepfun-cn", // pragma: allowlist secret
      },
      agentDir,
    });
    upsertAuthProfile({
      profileId: "stepfun-plan:cn",
      credential: {
        type: "api_key",
        provider: "stepfun-plan",
        key: "sk-stepfun-cn", // pragma: allowlist secret
      },
      agentDir,
    });

    const providers = await resolveImplicitProvidersForTest({ agentDir, env: {} });

    expect(providers?.stepfun?.baseUrl).toBe("https://api.stepfun.com/v1");
    expect(providers?.["stepfun-plan"]?.baseUrl).toBe("https://api.stepfun.com/step_plan/v1");
    expect(providers?.stepfun?.models?.map((model) => model.id)).toEqual(EXPECTED_STANDARD_MODELS);
    expect(providers?.["stepfun-plan"]?.models?.map((model) => model.id)).toEqual(
      EXPECTED_PLAN_MODELS,
    );
  });
});
