import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capturePluginRegistration,
  createRuntimeEnv,
  createTestWizardPrompter,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-onboard";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import {
  DATABRICKS_DEFAULT_MODEL_REF,
  DATABRICKS_MODEL_CATALOG,
  normalizeDatabricksHost,
  resolveDatabricksBaseUrl,
} from "./models.js";

function registerProvider() {
  const captured = capturePluginRegistration(plugin);
  const provider = captured.providers[0];
  if (!provider) {
    throw new Error("expected Databricks provider");
  }
  return provider;
}

describe("databricks provider plugin", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("registers Databricks auth and provider metadata", () => {
    const provider = registerProvider();
    expect(provider.id).toBe("databricks");
    expect(provider.label).toBe("Databricks");
    expect(provider.envVars).toEqual(["DATABRICKS_TOKEN"]);
    expect(provider.auth[0]?.id).toBe("api-token");
  });

  it("normalizes workspace hosts and builds the Unity Gateway base URL", () => {
    expect(normalizeDatabricksHost("dbc-example.cloud.databricks.com/")).toBe(
      "https://dbc-example.cloud.databricks.com",
    );
    expect(resolveDatabricksBaseUrl("https://dbc-example.cloud.databricks.com/")).toBe(
      "https://dbc-example.cloud.databricks.com/ai-gateway/mlflow/v1",
    );
    expect(normalizeDatabricksHost("http://dbc-example.cloud.databricks.com")).toBeUndefined();
  });

  it("uses a Databricks-qualified default model ref", () => {
    expect(DATABRICKS_DEFAULT_MODEL_REF).toBe("databricks/system.ai.claude-sonnet-4-5");
  });

  it("matches the documented GPT-5.6 Sol token limits", () => {
    const model = DATABRICKS_MODEL_CATALOG.find((entry) => entry.id === "system.ai.gpt-5-6-sol");
    expect(model).toMatchObject({
      contextWindow: 1_050_000,
      maxTokens: 128_000,
      input: ["text", "image"],
      reasoning: true,
    });
  });

  it("runs registered interactive auth without an explicit env context", async () => {
    const auth = registerProvider().auth[0];
    if (!auth) {
      throw new Error("expected Databricks auth method");
    }
    vi.stubEnv("DATABRICKS_HOST", "");
    const result = await auth.run({
      config: {},
      opts: { databricksToken: "test-token" },
      runtime: createRuntimeEnv(),
      prompter: createTestWizardPrompter({
        text: vi.fn(async () => "https://dbc-example.cloud.databricks.com"),
      }),
      secretInputMode: "plaintext",
      isRemote: false,
      openUrl: vi.fn(),
      oauth: { createVpsAwareHandlers: vi.fn() },
    });

    expect(result.profiles).toEqual([
      {
        profileId: "databricks:default",
        credential: { type: "api_key", provider: "databricks", key: "test-token" },
      },
    ]);
    expect(result.configPatch?.models?.providers?.databricks?.baseUrl).toBe(
      "https://dbc-example.cloud.databricks.com/ai-gateway/mlflow/v1",
    );
  });

  it("selects the Databricks default on fresh registered non-interactive setup", async () => {
    const auth = registerProvider().auth[0];
    if (!auth?.runNonInteractive) {
      throw new Error("expected Databricks non-interactive auth method");
    }
    vi.stubEnv("DATABRICKS_HOST", "https://dbc-example.cloud.databricks.com/");
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-databricks-fresh-auth-"));

    try {
      const result = await auth.runNonInteractive({
        authChoice: "databricks-token",
        config: {},
        baseConfig: {},
        opts: { databricksToken: "test-token" },
        runtime: createRuntimeEnv(),
        agentDir,
        resolveApiKey: async () => ({ key: "test-token", source: "flag" }),
        toApiKeyCredential: ({ provider, resolved }) => ({
          type: "api_key",
          provider,
          key: resolved.key,
        }),
      });

      expect(result?.agents?.defaults?.model).toMatchObject({
        primary: DATABRICKS_DEFAULT_MODEL_REF,
      });
      expect(result?.models?.providers?.databricks?.baseUrl).toBe(
        "https://dbc-example.cloud.databricks.com/ai-gateway/mlflow/v1",
      );
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("runs registered non-interactive auth from DATABRICKS_HOST and preserves existing config", async () => {
    const auth = registerProvider().auth[0];
    if (!auth?.runNonInteractive) {
      throw new Error("expected Databricks non-interactive auth method");
    }
    vi.stubEnv("DATABRICKS_HOST", "https://dbc-example.cloud.databricks.com/");
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-databricks-auth-"));
    const config: OpenClawConfig = {
      models: {
        providers: {
          existing: {
            baseUrl: "https://existing.example/v1",
            models: [],
          },
        },
      },
      agents: {
        defaults: {
          model: { primary: "existing/model" },
          models: {
            "existing/model": { alias: "Keep me" },
          },
        },
      },
    };

    try {
      const result = await auth.runNonInteractive({
        authChoice: "databricks-token",
        config,
        baseConfig: config,
        opts: { databricksToken: "test-token" },
        runtime: createRuntimeEnv(),
        agentDir,
        resolveApiKey: async () => ({ key: "test-token", source: "flag" }),
        toApiKeyCredential: ({ provider, resolved }) => ({
          type: "api_key",
          provider,
          key: resolved.key,
        }),
      });

      expect(result?.models?.providers?.databricks?.baseUrl).toBe(
        "https://dbc-example.cloud.databricks.com/ai-gateway/mlflow/v1",
      );
      expect(result?.models?.providers?.existing).toEqual(config.models?.providers?.existing);
      expect(result?.agents?.defaults?.model).toMatchObject({ primary: "existing/model" });
      expect(result?.agents?.defaults?.models?.["existing/model"]).toEqual({ alias: "Keep me" });
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("resolves arbitrary Databricks model-service names into runtime models", () => {
    const provider = registerProvider();
    const model = provider.resolveDynamicModel?.({
      provider: "databricks",
      modelId: "main.agents.custom-service",
      providerConfig: {
        baseUrl: "https://dbc-example.cloud.databricks.com/ai-gateway/mlflow/v1",
        models: [],
      },
      config: {},
    } as never);

    expect(model).toMatchObject({
      id: "main.agents.custom-service",
      provider: "databricks",
      api: "openai-completions",
      baseUrl: "https://dbc-example.cloud.databricks.com/ai-gateway/mlflow/v1",
      reasoning: false,
      input: ["text"],
      contextWindow: 128000,
      maxTokens: 8192,
    });
  });
});
