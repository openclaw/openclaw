import {
  capturePluginRegistration,
  createNonExitingRuntimeEnv,
  createRuntimeEnv,
  createTestWizardPrompter,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-onboard";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import {
  DATABRICKS_DEFAULT_MODEL_REF,
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

  it("normalizes workspace hosts and builds the Unity Gateway base URL", () => {
    expect(normalizeDatabricksHost("dbc-example.cloud.databricks.com/")).toBe(
      "https://dbc-example.cloud.databricks.com",
    );
    expect(resolveDatabricksBaseUrl("https://dbc-example.cloud.databricks.com/")).toBe(
      "https://dbc-example.cloud.databricks.com/ai-gateway/mlflow/v1",
    );
    expect(normalizeDatabricksHost("http://dbc-example.cloud.databricks.com")).toBeUndefined();
  });

  // Built at runtime so the fixtures carry no credential-shaped URL literal for secret scanners.
  const workspaceUrl = (mutate: (url: URL) => void) => {
    const url = new URL("https://dbc-example.cloud.databricks.com");
    mutate(url);
    return url.href;
  };

  it.each([
    [
      "userinfo",
      workspaceUrl((url) => {
        url.username = "operator";
        url.password = "placeholder";
      }),
    ],
    ["a query", workspaceUrl((url) => url.searchParams.set("next", "x"))],
    ["a fragment", workspaceUrl((url) => (url.hash = "section"))],
    ["only whitespace", "   "],
  ])("rejects a workspace host with %s so it never reaches the base URL", (_label, host) => {
    expect(normalizeDatabricksHost(host)).toBeUndefined();
    expect(resolveDatabricksBaseUrl(host)).toBeUndefined();
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

    const result = await auth.runNonInteractive({
      authChoice: "databricks-token",
      config: {},
      baseConfig: {},
      opts: { databricksToken: "test-token" },
      runtime: createRuntimeEnv(),
      resolveApiKey: async () => ({ key: "test-token", source: "profile" }),
      toApiKeyCredential: () => null,
    });

    expect(result?.agents?.defaults?.model).toMatchObject({
      primary: DATABRICKS_DEFAULT_MODEL_REF,
    });
    expect(result?.models?.providers?.databricks?.baseUrl).toBe(
      "https://dbc-example.cloud.databricks.com/ai-gateway/mlflow/v1",
    );
    expect(result?.auth?.profiles?.["databricks:default"]).toMatchObject({
      provider: "databricks",
      mode: "api_key",
    });
  });

  it("runs registered non-interactive auth from DATABRICKS_HOST and preserves existing config", async () => {
    const auth = registerProvider().auth[0];
    if (!auth?.runNonInteractive) {
      throw new Error("expected Databricks non-interactive auth method");
    }
    vi.stubEnv("DATABRICKS_HOST", "https://dbc-example.cloud.databricks.com/");
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

    const result = await auth.runNonInteractive({
      authChoice: "databricks-token",
      config,
      baseConfig: config,
      opts: { databricksToken: "test-token" },
      runtime: createRuntimeEnv(),
      resolveApiKey: async () => ({ key: "test-token", source: "profile" }),
      toApiKeyCredential: () => null,
    });

    expect(result?.models?.providers?.databricks?.baseUrl).toBe(
      "https://dbc-example.cloud.databricks.com/ai-gateway/mlflow/v1",
    );
    expect(result?.models?.providers?.existing).toEqual(config.models?.providers?.existing);
    expect(result?.agents?.defaults?.model).toMatchObject({ primary: "existing/model" });
    expect(result?.agents?.defaults?.models?.["existing/model"]).toEqual({ alias: "Keep me" });
  });

  it("resolves arbitrary Databricks model-service names into runtime models", () => {
    const provider = registerProvider();
    const model = provider.resolveDynamicModel?.({
      provider: "databricks",
      modelId: "main.agents.custom-service",
      providerConfig: {
        baseUrl: "https://dbc-example.cloud.databricks.com/ai-gateway/mlflow/v1/",
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

  it("fails non-interactive setup without DATABRICKS_HOST and leaves no orphaned credential", async () => {
    const auth = registerProvider().auth[0];
    if (!auth?.runNonInteractive) {
      throw new Error("expected Databricks non-interactive auth method");
    }
    vi.stubEnv("DATABRICKS_HOST", "");
    const runtime = createNonExitingRuntimeEnv();
    const toApiKeyCredential = vi.fn();

    const result = await auth.runNonInteractive({
      authChoice: "databricks-token",
      config: {},
      baseConfig: {},
      opts: { databricksToken: "test-token" },
      runtime,
      resolveApiKey: async () => ({ key: "test-token", source: "flag" }),
      toApiKeyCredential,
    });

    expect(result).toBeNull();
    expect(toApiKeyCredential).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(
      "Databricks setup requires DATABRICKS_HOST to be set to the HTTPS workspace URL.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("fails non-interactive setup on an invalid DATABRICKS_HOST instead of keeping the configured workspace", async () => {
    const auth = registerProvider().auth[0];
    if (!auth?.runNonInteractive) {
      throw new Error("expected Databricks non-interactive auth method");
    }
    const configured: OpenClawConfig = {
      models: {
        providers: {
          databricks: {
            baseUrl: "https://dbc-configured.cloud.databricks.com/ai-gateway/mlflow/v1",
            models: [],
          },
        },
      },
    };
    vi.stubEnv("DATABRICKS_HOST", "https://dbc-other.cloud.databricks.com/?o=123");
    const runtime = createNonExitingRuntimeEnv();
    const toApiKeyCredential = vi.fn();

    const result = await auth.runNonInteractive({
      authChoice: "databricks-token",
      config: configured,
      baseConfig: configured,
      opts: { databricksToken: "other-workspace-token" },
      runtime,
      resolveApiKey: async () => ({ key: "other-workspace-token", source: "flag" }),
      toApiKeyCredential,
    });

    expect(result).toBeNull();
    expect(toApiKeyCredential).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(
      "Databricks setup requires DATABRICKS_HOST to be set to the HTTPS workspace URL.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("publishes the Unity Gateway catalog only for a token and a configured gateway route", async () => {
    const catalog = registerProvider().catalog;
    if (!catalog || !("run" in catalog)) {
      throw new Error("expected Databricks provider catalog");
    }
    const baseUrl = "https://dbc-example.cloud.databricks.com/ai-gateway/mlflow/v1";
    const context = (apiKey: string | undefined, configuredBaseUrl: string | undefined) =>
      ({
        config: configuredBaseUrl
          ? {
              models: {
                providers: { databricks: { baseUrl: `${configuredBaseUrl}//`, models: [] } },
              },
            }
          : {},
        env: {},
        resolveProviderApiKey: () => ({ apiKey }),
      }) as never;

    expect(await catalog.run(context(undefined, baseUrl))).toBeNull();
    expect(await catalog.run(context("test-token", undefined))).toBeNull();
    expect(
      await catalog.run(
        context("test-token", "https://dbc-example.cloud.databricks.com/serving-endpoints"),
      ),
    ).toBeNull();
    const published = await catalog.run(context("test-token", baseUrl));
    expect(published).toMatchObject({
      provider: {
        baseUrl,
        api: "openai-completions",
        apiKey: "test-token",
        models: [{ id: "system.ai.claude-sonnet-4-5" }],
      },
    });
  });

  it("falls back to DATABRICKS_HOST for dynamic models when no provider config exists", () => {
    const provider = registerProvider();
    const resolve = (modelId: string) =>
      provider.resolveDynamicModel?.({
        provider: "databricks",
        modelId,
        providerConfig: undefined,
        config: {},
      } as never);

    vi.stubEnv("DATABRICKS_HOST", "dbc-env.cloud.databricks.com");
    expect(resolve("system.ai.claude-sonnet-4-6")).toMatchObject({
      id: "system.ai.claude-sonnet-4-6",
      baseUrl: "https://dbc-env.cloud.databricks.com/ai-gateway/mlflow/v1",
    });

    vi.stubEnv("DATABRICKS_HOST", "");
    expect(resolve("system.ai.claude-sonnet-4-6")).toBeUndefined();
  });

  it("reuses the configured workspace to rotate the token, and lets DATABRICKS_HOST replace it", async () => {
    const auth = registerProvider().auth[0];
    if (!auth?.runNonInteractive) {
      throw new Error("expected Databricks non-interactive auth method");
    }
    const configured: OpenClawConfig = {
      models: {
        providers: {
          databricks: {
            baseUrl: "https://dbc-configured.cloud.databricks.com/ai-gateway/mlflow/v1",
            models: [],
          },
        },
      },
    };
    const rotate = () =>
      auth.runNonInteractive!({
        authChoice: "databricks-token",
        config: configured,
        baseConfig: configured,
        opts: { databricksToken: "rotated-token" },
        runtime: createRuntimeEnv(),
        resolveApiKey: async () => ({ key: "rotated-token", source: "profile" }),
        toApiKeyCredential: () => null,
      });

    vi.stubEnv("DATABRICKS_HOST", "");
    expect((await rotate())?.models?.providers?.databricks?.baseUrl).toBe(
      "https://dbc-configured.cloud.databricks.com/ai-gateway/mlflow/v1",
    );

    vi.stubEnv("DATABRICKS_HOST", "https://dbc-replacement.cloud.databricks.com");
    expect((await rotate())?.models?.providers?.databricks?.baseUrl).toBe(
      "https://dbc-replacement.cloud.databricks.com/ai-gateway/mlflow/v1",
    );
  });

  it("reuses a stored token only for the workspace it was saved for", async () => {
    const auth = registerProvider().auth[0];
    if (!auth?.runNonInteractive || !auth.validateNonInteractive) {
      throw new Error("expected Databricks non-interactive auth methods");
    }
    const configured: OpenClawConfig = {
      models: {
        providers: {
          databricks: {
            baseUrl: "https://dbc-configured.cloud.databricks.com/ai-gateway/mlflow/v1",
            models: [],
          },
        },
      },
    };
    const allowProfileSeen: Array<boolean | undefined> = [];
    // Mirrors core: with no flag or env token, only a permitted stored profile can supply one.
    const resolveApiKey = async (params: { allowProfile?: boolean }) => {
      allowProfileSeen.push(params.allowProfile);
      return params.allowProfile === false
        ? null
        : { key: "stored-token", source: "profile" as const };
    };
    const run = (config: OpenClawConfig) =>
      auth.runNonInteractive!({
        authChoice: "databricks-token",
        config,
        baseConfig: config,
        opts: {},
        runtime: createRuntimeEnv(),
        resolveApiKey,
        toApiKeyCredential: () => null,
      });
    const validate = (config: OpenClawConfig) =>
      auth.validateNonInteractive!({
        authChoice: "databricks-token",
        config,
        baseConfig: config,
        opts: {},
        runtime: createRuntimeEnv(),
        resolveApiKey,
      });

    vi.stubEnv("DATABRICKS_HOST", "");
    expect((await run(configured))?.models?.providers?.databricks?.baseUrl).toBe(
      "https://dbc-configured.cloud.databricks.com/ai-gateway/mlflow/v1",
    );
    vi.stubEnv("DATABRICKS_HOST", "https://DBC-configured.cloud.databricks.com/");
    expect(await validate(configured)).toBe(true);
    expect(allowProfileSeen).toEqual([true, true]);

    allowProfileSeen.length = 0;
    vi.stubEnv("DATABRICKS_HOST", "https://dbc-other.cloud.databricks.com");
    expect(await run(configured)).toBeNull();
    expect(await validate(configured)).toBe(false);
    expect(await run({})).toBeNull();
    expect(allowProfileSeen).toEqual([false, false, false]);
  });

  it("validates non-interactive prerequisites without side effects", async () => {
    const auth = registerProvider().auth[0];
    if (!auth?.validateNonInteractive) {
      throw new Error("expected Databricks non-interactive validation");
    }
    const runtime = createNonExitingRuntimeEnv();
    const validate = (token: string | null, config: OpenClawConfig = {}) =>
      auth.validateNonInteractive!({
        authChoice: "databricks-token",
        config,
        baseConfig: config,
        opts: {},
        runtime,
        resolveApiKey: async () => (token ? { key: token, source: "env" } : null),
      });

    vi.stubEnv("DATABRICKS_HOST", "https://dbc-example.cloud.databricks.com");
    expect(await validate("test-token")).toBe(true);
    expect(await validate(null)).toBe(false);
    expect(runtime.error).not.toHaveBeenCalled();

    vi.stubEnv("DATABRICKS_HOST", "");
    expect(await validate("test-token")).toBe(false);
    expect(runtime.error).toHaveBeenCalledWith(
      "Databricks setup requires DATABRICKS_HOST to be set to the HTTPS workspace URL.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(
      await validate("test-token", {
        models: {
          providers: {
            databricks: {
              baseUrl: "https://dbc-example.cloud.databricks.com/ai-gateway/mlflow/v1",
              models: [],
            },
          },
        },
      }),
    ).toBe(true);
  });

  it("keeps a configured route for the same workspace and sets the gateway for a different one", async () => {
    const auth = registerProvider().auth[0];
    if (!auth?.runNonInteractive) {
      throw new Error("expected Databricks non-interactive auth method");
    }
    const servingRoute = "https://dbc-example.cloud.databricks.com/serving-endpoints";
    const configured: OpenClawConfig = {
      models: { providers: { databricks: { baseUrl: `${servingRoute}/`, models: [] } } },
      agents: { defaults: { model: { primary: "databricks/legacy-endpoint" } } },
    };
    const onboard = (host: string) => {
      vi.stubEnv("DATABRICKS_HOST", host);
      return auth.runNonInteractive!({
        authChoice: "databricks-token",
        config: configured,
        baseConfig: configured,
        opts: { databricksToken: "test-token" },
        runtime: createRuntimeEnv(),
        resolveApiKey: async () => ({ key: "test-token", source: "profile" }),
        toApiKeyCredential: () => null,
      });
    };

    const sameWorkspace = await onboard("https://dbc-example.cloud.databricks.com");
    expect(sameWorkspace?.models?.providers?.databricks?.baseUrl).toBe(servingRoute);
    expect(sameWorkspace?.agents?.defaults?.model).toMatchObject({
      primary: "databricks/legacy-endpoint",
    });
    expect(sameWorkspace?.agents?.defaults?.models?.[DATABRICKS_DEFAULT_MODEL_REF]).toBeUndefined();

    const otherWorkspace = await onboard("https://dbc-other.cloud.databricks.com");
    expect(otherWorkspace?.models?.providers?.databricks?.baseUrl).toBe(
      "https://dbc-other.cloud.databricks.com/ai-gateway/mlflow/v1",
    );
  });

  it("keeps the configured API shape with a kept route, and offers no gateway default for it", async () => {
    const auth = registerProvider().auth[0];
    const servingRoute = "https://dbc-example.cloud.databricks.com/serving-endpoints/anthropic";
    const config: OpenClawConfig = {
      models: {
        providers: {
          databricks: { baseUrl: servingRoute, api: "anthropic-messages", models: [] },
        },
      },
    };
    vi.stubEnv("DATABRICKS_HOST", "https://dbc-example.cloud.databricks.com");

    const kept = await auth?.run({
      config,
      opts: { databricksToken: "test-token" },
      runtime: createRuntimeEnv(),
      prompter: createTestWizardPrompter(),
      secretInputMode: "plaintext",
      isRemote: false,
      openUrl: vi.fn(),
      oauth: { createVpsAwareHandlers: vi.fn() },
    });
    expect(kept?.configPatch?.models?.providers?.databricks).toMatchObject({
      baseUrl: servingRoute,
      api: "anthropic-messages",
    });
    expect(kept?.defaultModel).toBeUndefined();

    const fresh = await auth?.run({
      config: {},
      opts: { databricksToken: "test-token" },
      runtime: createRuntimeEnv(),
      prompter: createTestWizardPrompter(),
      secretInputMode: "plaintext",
      isRemote: false,
      openUrl: vi.fn(),
      oauth: { createVpsAwareHandlers: vi.fn() },
    });
    expect(fresh?.configPatch?.models?.providers?.databricks).toMatchObject({
      baseUrl: "https://dbc-example.cloud.databricks.com/ai-gateway/mlflow/v1",
      api: "openai-completions",
    });
    expect(fresh?.defaultModel).toBe(DATABRICKS_DEFAULT_MODEL_REF);
  });
});
