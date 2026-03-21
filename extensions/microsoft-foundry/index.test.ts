import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../test/helpers/extensions/plugin-api.js";
import plugin from "./index.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { isValidTenantIdentifier } from "./onboard.js";

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

    expect(config.models?.providers?.["microsoft-foundry"]?.models.map((model) => model.id)).toEqual([
      "alias-one",
      "alias-two",
    ]);
  });

  it("accepts tenant domains as valid tenant identifiers", () => {
    expect(isValidTenantIdentifier("contoso.onmicrosoft.com")).toBe(true);
    expect(isValidTenantIdentifier("00000000-0000-0000-0000-000000000000")).toBe(true);
    expect(isValidTenantIdentifier("not a tenant")).toBe(false);
  });
});
