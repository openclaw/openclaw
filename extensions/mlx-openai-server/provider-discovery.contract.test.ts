import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { beforeEach, describe, expect, it, vi } from "vitest";

const buildMlxOpenaiServerProviderMock = vi.hoisted(() => vi.fn());
type DiscoverOpenAICompatibleSelfHostedProviderParams = {
  buildProvider: (args: { apiKey?: string }) => Promise<Record<string, unknown>>;
  ctx: {
    resolveProviderApiKey: () => {
      apiKey?: string;
    };
    resolveProviderAuth: () => {
      discoveryApiKey?: string;
    };
  };
  providerId: string;
};
const discoverOpenAICompatibleSelfHostedProviderMock = vi.hoisted(() =>
  vi.fn(async (params: DiscoverOpenAICompatibleSelfHostedProviderParams) => ({
    provider: {
      ...(await params.buildProvider({
        apiKey: params.ctx.resolveProviderAuth().discoveryApiKey,
      })),
      apiKey: params.ctx.resolveProviderApiKey().apiKey,
    },
  })),
);

vi.mock("./api.js", () => ({
  MLX_OPENAI_SERVER_DEFAULT_API_KEY_ENV_VAR: "MLX_OPENAI_SERVER_API_KEY",
  MLX_OPENAI_SERVER_DEFAULT_BASE_URL: "http://127.0.0.1:8000/v1",
  MLX_OPENAI_SERVER_MODEL_PLACEHOLDER: "mlx-community/Qwen3-Coder-Next-4bit",
  MLX_OPENAI_SERVER_PROVIDER_LABEL: "MLX OpenAI Server",
  buildMlxOpenaiServerProvider: (...args: unknown[]) => buildMlxOpenaiServerProviderMock(...args),
}));

vi.mock("openclaw/plugin-sdk/provider-setup", () => ({
  discoverOpenAICompatibleSelfHostedProvider: (
    params: DiscoverOpenAICompatibleSelfHostedProviderParams,
  ) => discoverOpenAICompatibleSelfHostedProviderMock(params),
}));

type ProviderDiscoveryRun = (ctx: {
  config: Record<string, unknown>;
  env: NodeJS.ProcessEnv;
  resolveProviderApiKey: () => {
    apiKey: string | undefined;
    discoveryApiKey?: string;
  };
  resolveProviderAuth: () => {
    apiKey: string | undefined;
    discoveryApiKey?: string;
    mode: "api_key" | "oauth" | "token" | "none";
    source: "env" | "profile" | "none";
  };
}) => Promise<unknown>;

type RegisteredMlxOpenaiServerProvider = {
  id: string;
  discovery?: {
    order?: string;
    run: ProviderDiscoveryRun;
  };
};

describe("mlx-openai-server provider discovery contract", () => {
  beforeEach(() => {
    buildMlxOpenaiServerProviderMock.mockReset();
    discoverOpenAICompatibleSelfHostedProviderMock.mockClear();
  });

  it("keeps self-hosted discovery provider-owned", async () => {
    const { default: plugin } = await import("./index.js");
    let provider: RegisteredMlxOpenaiServerProvider | undefined;
    plugin.register({
      registerProvider: (registeredProvider) => {
        provider = registeredProvider as RegisteredMlxOpenaiServerProvider;
      },
    } as OpenClawPluginApi);
    expect(provider?.id).toBe("mlx-openai-server");
    expect(provider?.discovery?.order).toBe("late");
    const discovery = provider?.discovery;
    expect(discovery).toBeDefined();

    buildMlxOpenaiServerProviderMock.mockResolvedValueOnce({
      baseUrl: "http://127.0.0.1:8000/v1",
      api: "openai-completions",
      models: [{ id: "mlx-community/Qwen3-Coder-Next-4bit", name: "Qwen3 Coder Next" }],
    });

    await expect(
      discovery!.run({
        config: {},
        env: {
          MLX_OPENAI_SERVER_API_KEY: "env-mlx-key",
        } as NodeJS.ProcessEnv,
        resolveProviderApiKey: () => ({
          apiKey: "MLX_OPENAI_SERVER_API_KEY",
          discoveryApiKey: "env-mlx-key",
        }),
        resolveProviderAuth: () => ({
          apiKey: "MLX_OPENAI_SERVER_API_KEY",
          discoveryApiKey: "env-mlx-key",
          mode: "api_key",
          source: "env",
        }),
      }),
    ).resolves.toEqual({
      provider: {
        baseUrl: "http://127.0.0.1:8000/v1",
        api: "openai-completions",
        apiKey: "MLX_OPENAI_SERVER_API_KEY",
        models: [{ id: "mlx-community/Qwen3-Coder-Next-4bit", name: "Qwen3 Coder Next" }],
      },
    });
    expect(buildMlxOpenaiServerProviderMock).toHaveBeenCalledWith({
      apiKey: "env-mlx-key",
    });
    expect(discoverOpenAICompatibleSelfHostedProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "mlx-openai-server",
        buildProvider: expect.any(Function),
      }),
    );
  });
});
