import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import stepfunPlugin from "../../extensions/stepfun/index.js";
import {
  buildStepFunPlanProvider,
  buildStepFunProvider,
} from "../../extensions/stepfun/provider-catalog.js";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "../../test/helpers/plugins/provider-registration.js";
import { upsertAuthProfile } from "./auth-profiles.js";
import { resolveImplicitProvidersForTest } from "./models-config.e2e-harness.js";
import { resolveMissingProviderApiKey } from "./models-config.providers.secrets.js";

const EXPECTED_STANDARD_MODELS = ["step-3.5-flash"];
const EXPECTED_PLAN_MODELS = ["step-3.5-flash", "step-3.5-flash-2603"];

describe("StepFun provider catalog", () => {
  it("includes standard and Step Plan providers when STEPFUN_API_KEY is configured", async () => {
    const env = { STEPFUN_API_KEY: "test-stepfun-key" } as NodeJS.ProcessEnv;
    const standardProvider = resolveMissingProviderApiKey({
      providerKey: "stepfun",
      provider: buildStepFunProvider(),
      env,
      profileApiKey: undefined,
    });
    const planProvider = resolveMissingProviderApiKey({
      providerKey: "stepfun-plan",
      provider: buildStepFunPlanProvider(),
      env,
      profileApiKey: undefined,
    });

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
    const { providers } = await registerProviderPlugin({
      plugin: stepfunPlugin,
      id: "stepfun",
      name: "StepFun",
    });
    const standardProvider = requireRegisteredProvider(providers, "stepfun");
    const planProvider = requireRegisteredProvider(providers, "stepfun-plan");
    const config = {
      models: {
        providers: {
          "stepfun-plan": {
            baseUrl: "https://api.stepfun.com/step_plan/v1",
            models: [],
          },
        },
      },
    };
    const resolveProviderApiKey = () => ({
      apiKey: "STEPFUN_API_KEY",
      discoveryApiKey: "test-stepfun-key",
    });
    const resolveProviderAuth = () => ({
      apiKey: "STEPFUN_API_KEY",
      discoveryApiKey: "test-stepfun-key",
      mode: "api_key" as const,
      source: "env" as const,
    });

    const standardCatalog = await standardProvider.catalog?.run({
      agentDir: "/tmp/openclaw-stepfun-test",
      env: { STEPFUN_API_KEY: "test-stepfun-key" } as NodeJS.ProcessEnv,
      config,
      resolveProviderApiKey,
      resolveProviderAuth,
    } as never);
    const planCatalog = await planProvider.catalog?.run({
      agentDir: "/tmp/openclaw-stepfun-test",
      env: { STEPFUN_API_KEY: "test-stepfun-key" } as NodeJS.ProcessEnv,
      config,
      resolveProviderApiKey,
      resolveProviderAuth,
    } as never);

    expect(standardCatalog?.provider.baseUrl).toBe("https://api.stepfun.com/v1");
    expect(planCatalog?.provider.baseUrl).toBe("https://api.stepfun.com/step_plan/v1");
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
