import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { createTestPluginApi } from "../../test/helpers/extensions/plugin-api.js";
import plugin from "./index.js";
import { buildFoundryConnectionTest, isValidTenantIdentifier } from "./onboard.js";
import { buildFoundryAuthResult } from "./shared.js";

const execFileMock = vi.hoisted(() => vi.fn());
const execFileSyncMock = vi.hoisted(() => vi.fn());
const ensureAuthProfileStoreMock = vi.hoisted(() =>
  vi.fn(() => ({
    profiles: {},
  })),
);

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: execFileMock,
    execFileSync: execFileSyncMock,
  };
});

vi.mock("openclaw/plugin-sdk/provider-auth", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/provider-auth")>(
    "openclaw/plugin-sdk/provider-auth",
  );
  return {
    ...actual,
    ensureAuthProfileStore: ensureAuthProfileStoreMock,
  };
});

function registerProvider() {
  const registerProviderMock = vi.fn();
  plugin.register(
    createTestPluginApi({
      id: "microsoft-foundry",
      name: "Microsoft Foundry",
      source: "test",
      config: {},
      runtime: {} as never,
      registerProvider: registerProviderMock,
    }),
  );
  expect(registerProviderMock).toHaveBeenCalledTimes(1);
  return registerProviderMock.mock.calls[0]?.[0];
}

describe("microsoft-foundry plugin", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    execFileSyncMock.mockReset();
    ensureAuthProfileStoreMock.mockReset();
    ensureAuthProfileStoreMock.mockReturnValue({ profiles: {} });
  });

  it("keeps the API key profile bound when multiple auth profiles exist without explicit order", async () => {
    const provider = registerProvider();
    const config: OpenClawConfig = {
      auth: {
        profiles: {
          "microsoft-foundry:default": {
            provider: "microsoft-foundry",
            mode: "api_key" as const,
          },
          "microsoft-foundry:entra": {
            provider: "microsoft-foundry",
            mode: "api_key" as const,
          },
        },
      },
      models: {
        providers: {
          "microsoft-foundry": {
            baseUrl: "https://example.services.ai.azure.com/openai/v1",
            api: "openai-responses",
            models: [
              {
                id: "gpt-5.4",
                name: "gpt-5.4",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128_000,
                maxTokens: 16_384,
              },
            ],
          },
        },
      },
    };

    await provider.onModelSelected?.({
      config,
      model: "microsoft-foundry/gpt-5.4",
      prompter: {} as never,
      agentDir: "/tmp/test-agent",
    });

    expect(config.auth?.order?.["microsoft-foundry"]).toBeUndefined();
  });

  it("uses the active ordered API key profile when model selection rebinding is needed", async () => {
    const provider = registerProvider();
    ensureAuthProfileStoreMock.mockReturnValueOnce({
      profiles: {
        "microsoft-foundry:default": {
          type: "api_key",
          provider: "microsoft-foundry",
          metadata: { authMethod: "api-key" },
        },
      },
    });
    const config: OpenClawConfig = {
      auth: {
        profiles: {
          "microsoft-foundry:default": {
            provider: "microsoft-foundry",
            mode: "api_key" as const,
          },
        },
        order: {
          "microsoft-foundry": ["microsoft-foundry:default"],
        },
      },
      models: {
        providers: {
          "microsoft-foundry": {
            baseUrl: "https://example.services.ai.azure.com/openai/v1",
            api: "openai-responses",
            models: [
              {
                id: "gpt-5.4",
                name: "gpt-5.4",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128_000,
                maxTokens: 16_384,
              },
            ],
          },
        },
      },
    };

    await provider.onModelSelected?.({
      config,
      model: "microsoft-foundry/gpt-5.4",
      prompter: {} as never,
      agentDir: "/tmp/test-agent",
    });

    expect(config.auth?.order?.["microsoft-foundry"]).toEqual(["microsoft-foundry:default"]);
  });

  it("preserves the model-derived base URL for Entra runtime auth refresh", async () => {
    const provider = registerProvider();
    execFileMock.mockImplementationOnce(
      (
        _file: unknown,
        _args: unknown,
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        callback(
          null,
          JSON.stringify({
            accessToken: "test-token",
            expiresOn: new Date(Date.now() + 60_000).toISOString(),
          }),
          "",
        );
      },
    );
    ensureAuthProfileStoreMock.mockReturnValueOnce({
      profiles: {
        "microsoft-foundry:entra": {
          type: "api_key",
          provider: "microsoft-foundry",
          metadata: {
            authMethod: "entra-id",
            endpoint: "https://example.services.ai.azure.com",
            modelId: "custom-deployment",
            modelName: "gpt-5.4",
            tenantId: "tenant-id",
          },
        },
      },
    });

    const prepared = await provider.prepareRuntimeAuth?.({
      provider: "microsoft-foundry",
      modelId: "custom-deployment",
      model: {
        provider: "microsoft-foundry",
        id: "custom-deployment",
        name: "gpt-5.4",
        api: "openai-responses",
        baseUrl: "https://example.services.ai.azure.com/openai/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 16_384,
      },
      apiKey: "__entra_id_dynamic__",
      authMode: "api_key",
      profileId: "microsoft-foundry:entra",
      env: process.env,
      agentDir: "/tmp/test-agent",
    });

    expect(prepared?.baseUrl).toBe("https://example.services.ai.azure.com/openai/v1");
  });

  it("dedupes concurrent Entra token refreshes for the same profile", async () => {
    const provider = registerProvider();
    execFileMock.mockImplementationOnce(
      (
        _file: unknown,
        _args: unknown,
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        setTimeout(() => {
          callback(
            null,
            JSON.stringify({
              accessToken: "deduped-token",
              expiresOn: new Date(Date.now() + 60_000).toISOString(),
            }),
            "",
          );
        }, 10);
      },
    );
    ensureAuthProfileStoreMock.mockReturnValue({
      profiles: {
        "microsoft-foundry:entra": {
          type: "api_key",
          provider: "microsoft-foundry",
          metadata: {
            authMethod: "entra-id",
            endpoint: "https://example.services.ai.azure.com",
            modelId: "custom-deployment",
            modelName: "gpt-5.4",
            tenantId: "tenant-id",
          },
        },
      },
    });

    const runtimeContext = {
      provider: "microsoft-foundry",
      modelId: "custom-deployment",
      model: {
        provider: "microsoft-foundry",
        id: "custom-deployment",
        name: "gpt-5.4",
        api: "openai-responses",
        baseUrl: "https://example.services.ai.azure.com/openai/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 16_384,
      },
      apiKey: "__entra_id_dynamic__",
      authMode: "api_key",
      profileId: "microsoft-foundry:entra",
      env: process.env,
      agentDir: "/tmp/test-agent",
    };

    const [first, second] = await Promise.all([
      provider.prepareRuntimeAuth?.(runtimeContext),
      provider.prepareRuntimeAuth?.(runtimeContext),
    ]);

    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(first?.apiKey).toBe("deduped-token");
    expect(second?.apiKey).toBe("deduped-token");
  });

  it("keeps other configured Foundry models when switching the selected model", async () => {
    const provider = registerProvider();
    const config: OpenClawConfig = {
      auth: {
        profiles: {
          "microsoft-foundry:default": {
            provider: "microsoft-foundry",
            mode: "api_key" as const,
          },
        },
        order: {
          "microsoft-foundry": ["microsoft-foundry:default"],
        },
      },
      models: {
        providers: {
          "microsoft-foundry": {
            baseUrl: "https://example.services.ai.azure.com/openai/v1",
            api: "openai-responses",
            models: [
              {
                id: "alias-one",
                name: "gpt-5.4",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128_000,
                maxTokens: 16_384,
              },
              {
                id: "alias-two",
                name: "gpt-4o",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128_000,
                maxTokens: 16_384,
              },
            ],
          },
        },
      },
    };

    await provider.onModelSelected?.({
      config,
      model: "microsoft-foundry/alias-one",
      prompter: {} as never,
      agentDir: "/tmp/test-agent",
    });

    expect(
      config.models?.providers?.["microsoft-foundry"]?.models.map((model) => model.id),
    ).toEqual(["alias-one", "alias-two"]);
  });

  it("accepts tenant domains as valid tenant identifiers", () => {
    expect(isValidTenantIdentifier("contoso.onmicrosoft.com")).toBe(true);
    expect(isValidTenantIdentifier("00000000-0000-0000-0000-000000000000")).toBe(true);
    expect(isValidTenantIdentifier("not a tenant")).toBe(false);
  });

  it("writes Azure API key header overrides for API-key auth configs", () => {
    const result = buildFoundryAuthResult({
      profileId: "microsoft-foundry:default",
      apiKey: "test-api-key",
      endpoint: "https://example.services.ai.azure.com",
      modelId: "gpt-4o",
      authMethod: "api-key",
    });

    expect(result.configPatch?.models?.providers?.["microsoft-foundry"]).toMatchObject({
      apiKey: "test-api-key",
      authHeader: false,
      headers: { "api-key": "test-api-key" },
    });
  });

  it("uses the minimum supported response token count for GPT-5 connection tests", () => {
    const testRequest = buildFoundryConnectionTest({
      endpoint: "https://example.services.ai.azure.com",
      modelId: "gpt-5.4",
      modelNameHint: "gpt-5.4",
    });

    expect(testRequest.url).toContain("/responses");
    expect(testRequest.body).toMatchObject({
      model: "gpt-5.4",
      max_output_tokens: 16,
    });
  });

  it("includes api-version for non GPT-5 chat completion connection tests", () => {
    const testRequest = buildFoundryConnectionTest({
      endpoint: "https://example.services.ai.azure.com",
      modelId: "FW-GLM-5",
      modelNameHint: "FW-GLM-5",
    });

    expect(testRequest.url).toContain("/chat/completions?api-version=2024-12-01-preview");
    expect(testRequest.body).toMatchObject({
      max_tokens: 1,
    });
  });

  it("keeps Azure API key header overrides when API-key auth uses a secret ref", () => {
    const secretRef = {
      source: "env" as const,
      provider: "default",
      id: "AZURE_OPENAI_API_KEY",
    };
    const result = buildFoundryAuthResult({
      profileId: "microsoft-foundry:default",
      apiKey: secretRef,
      endpoint: "https://example.services.ai.azure.com",
      modelId: "gpt-4o",
      authMethod: "api-key",
    });

    expect(result.configPatch?.models?.providers?.["microsoft-foundry"]).toMatchObject({
      apiKey: secretRef,
      authHeader: false,
      headers: { "api-key": secretRef },
    });
  });

  it("moves the selected Foundry auth profile to the front of auth.order", () => {
    const result = buildFoundryAuthResult({
      profileId: "microsoft-foundry:entra",
      apiKey: "__entra_id_dynamic__",
      endpoint: "https://example.services.ai.azure.com",
      modelId: "gpt-5.4",
      authMethod: "entra-id",
      currentProviderProfileIds: ["microsoft-foundry:default", "microsoft-foundry:entra"],
    });

    expect(result.configPatch?.auth?.order?.["microsoft-foundry"]).toEqual([
      "microsoft-foundry:entra",
      "microsoft-foundry:default",
    ]);
  });

  it("persists discovered deployments alongside the selected default model", () => {
    const result = buildFoundryAuthResult({
      profileId: "microsoft-foundry:entra",
      apiKey: "__entra_id_dynamic__",
      endpoint: "https://example.services.ai.azure.com",
      modelId: "deployment-gpt5",
      modelNameHint: "gpt-5.4",
      authMethod: "entra-id",
      deployments: [
        { name: "deployment-gpt5", modelName: "gpt-5.4" },
        { name: "deployment-gpt4o", modelName: "gpt-4o" },
      ],
    });

    const provider = result.configPatch?.models?.providers?.["microsoft-foundry"];
    expect(provider?.models.map((model) => model.id)).toEqual([
      "deployment-gpt5",
      "deployment-gpt4o",
    ]);
    expect(result.defaultModel).toBe("microsoft-foundry/deployment-gpt5");
  });
});
