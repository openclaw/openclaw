import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  completeMock: vi.fn(),
  resolveModelMock: vi.fn(),
  getApiKeyForModelMock: vi.fn(),
  applyLocalNoAuthHeaderOverrideMock: vi.fn(),
  setRuntimeApiKeyMock: vi.fn(),
  resolveCopilotApiTokenMock: vi.fn(),
  prepareProviderRuntimeAuthMock: vi.fn(),
  registerProviderStreamForModelMock: vi.fn(),
}));

vi.mock("@mariozechner/pi-ai", () => ({
  complete: hoisted.completeMock,
}));

vi.mock("./pi-embedded-runner/model.js", () => ({
  resolveModel: hoisted.resolveModelMock,
}));

vi.mock("./model-auth.js", () => ({
  getApiKeyForModel: hoisted.getApiKeyForModelMock,
  applyLocalNoAuthHeaderOverride: hoisted.applyLocalNoAuthHeaderOverrideMock,
  isNonSecretApiKeyMarker: (value: string) =>
    value === "custom-local" || value === "plamo-request-auth",
}));

vi.mock("./github-copilot-token.js", () => ({
  resolveCopilotApiToken: hoisted.resolveCopilotApiTokenMock,
}));

vi.mock("../plugins/provider-runtime.runtime.js", () => ({
  prepareProviderRuntimeAuth: hoisted.prepareProviderRuntimeAuthMock,
}));

vi.mock("./provider-stream.js", () => ({
  registerProviderStreamForModel: hoisted.registerProviderStreamForModelMock,
}));

let prepareSimpleCompletionModel: typeof import("./simple-completion-runtime.js").prepareSimpleCompletionModel;
let completeWithPreparedSimpleCompletionModel: typeof import("./simple-completion-runtime.js").completeWithPreparedSimpleCompletionModel;

beforeAll(async () => {
  ({ prepareSimpleCompletionModel, completeWithPreparedSimpleCompletionModel } =
    await import("./simple-completion-runtime.js"));
});

beforeEach(() => {
  hoisted.completeMock.mockReset();
  hoisted.resolveModelMock.mockReset();
  hoisted.getApiKeyForModelMock.mockReset();
  hoisted.applyLocalNoAuthHeaderOverrideMock.mockReset();
  hoisted.setRuntimeApiKeyMock.mockReset();
  hoisted.resolveCopilotApiTokenMock.mockReset();
  hoisted.prepareProviderRuntimeAuthMock.mockReset();
  hoisted.registerProviderStreamForModelMock.mockReset();

  hoisted.applyLocalNoAuthHeaderOverrideMock.mockImplementation((model: unknown) => model);

  hoisted.resolveModelMock.mockReturnValue({
    model: {
      provider: "anthropic",
      id: "claude-opus-4-6",
    },
    authStorage: {
      setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
    },
    modelRegistry: {},
  });
  hoisted.getApiKeyForModelMock.mockResolvedValue({
    apiKey: "sk-test",
    source: "env:TEST_API_KEY",
    mode: "api-key",
  });
  hoisted.resolveCopilotApiTokenMock.mockResolvedValue({
    token: "copilot-runtime-token",
    expiresAt: Date.now() + 60_000,
    source: "cache:/tmp/copilot-token.json",
    baseUrl: "https://api.individual.githubcopilot.com",
  });
  hoisted.prepareProviderRuntimeAuthMock.mockResolvedValue(undefined);
  hoisted.completeMock.mockResolvedValue("ok");
  hoisted.registerProviderStreamForModelMock.mockReturnValue(undefined);
});

describe("prepareSimpleCompletionModel", () => {
  it("resolves model auth and sets runtime api key", async () => {
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: " sk-test ",
      source: "env:TEST_API_KEY",
      mode: "api-key",
    });

    const result = await prepareSimpleCompletionModel({
      cfg: undefined,
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      agentDir: "/tmp/openclaw-agent",
    });

    expect(result).toEqual(
      expect.objectContaining({
        model: expect.objectContaining({
          provider: "anthropic",
          id: "claude-opus-4-6",
        }),
        auth: expect.objectContaining({
          mode: "api-key",
          source: "env:TEST_API_KEY",
        }),
      }),
    );
    expect(hoisted.setRuntimeApiKeyMock).toHaveBeenCalledWith("anthropic", "sk-test");
  });

  it("returns error when model resolution fails", async () => {
    hoisted.resolveModelMock.mockReturnValueOnce({
      error: "Unknown model: anthropic/missing-model",
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });

    const result = await prepareSimpleCompletionModel({
      cfg: undefined,
      provider: "anthropic",
      modelId: "missing-model",
    });

    expect(result).toEqual({
      error: "Unknown model: anthropic/missing-model",
    });
    expect(hoisted.getApiKeyForModelMock).not.toHaveBeenCalled();
  });

  it("returns error when api key is missing and mode is not allowlisted", async () => {
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      source: "models.providers.anthropic",
      mode: "api-key",
    });

    const result = await prepareSimpleCompletionModel({
      cfg: undefined,
      provider: "anthropic",
      modelId: "claude-opus-4-6",
    });

    expect(result).toEqual({
      error: 'No API key resolved for provider "anthropic" (auth mode: api-key).',
      auth: {
        source: "models.providers.anthropic",
        mode: "api-key",
      },
    });
    expect(hoisted.setRuntimeApiKeyMock).not.toHaveBeenCalled();
  });

  it("continues without api key when auth mode is allowlisted", async () => {
    hoisted.resolveModelMock.mockReturnValueOnce({
      model: {
        provider: "amazon-bedrock",
        id: "anthropic.claude-sonnet-4-6",
      },
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      source: "aws-sdk default chain",
      mode: "aws-sdk",
    });

    const result = await prepareSimpleCompletionModel({
      cfg: undefined,
      provider: "amazon-bedrock",
      modelId: "anthropic.claude-sonnet-4-6",
      allowMissingApiKeyModes: ["aws-sdk"],
    });

    expect(result).toEqual(
      expect.objectContaining({
        model: expect.objectContaining({
          provider: "amazon-bedrock",
          id: "anthropic.claude-sonnet-4-6",
        }),
        auth: {
          source: "aws-sdk default chain",
          mode: "aws-sdk",
        },
      }),
    );
    expect(hoisted.setRuntimeApiKeyMock).not.toHaveBeenCalled();
  });

  it("exchanges github token when provider is github-copilot", async () => {
    hoisted.resolveModelMock.mockReturnValueOnce({
      model: {
        provider: "github-copilot",
        id: "gpt-4.1",
      },
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: "ghu_test",
      source: "profile:github-copilot:default",
      mode: "token",
    });

    await prepareSimpleCompletionModel({
      cfg: undefined,
      provider: "github-copilot",
      modelId: "gpt-4.1",
    });

    expect(hoisted.resolveCopilotApiTokenMock).toHaveBeenCalledWith({
      githubToken: "ghu_test",
    });
    expect(hoisted.setRuntimeApiKeyMock).toHaveBeenCalledWith(
      "github-copilot",
      "copilot-runtime-token",
    );
  });

  it("returns exchanged copilot token in auth.apiKey for github-copilot provider", async () => {
    hoisted.resolveModelMock.mockReturnValueOnce({
      model: {
        provider: "github-copilot",
        id: "gpt-4.1",
      },
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: "ghu_original_github_token",
      source: "profile:github-copilot:default",
      mode: "token",
    });

    const result = await prepareSimpleCompletionModel({
      cfg: undefined,
      provider: "github-copilot",
      modelId: "gpt-4.1",
    });

    expect(result).not.toHaveProperty("error");
    if ("error" in result) {
      return;
    }

    // The returned auth.apiKey should be the exchanged runtime token,
    // not the original GitHub token
    expect(result.auth.apiKey).toBe("copilot-runtime-token");
    expect(result.auth.apiKey).not.toBe("ghu_original_github_token");
  });

  it("applies exchanged copilot baseUrl to returned model", async () => {
    hoisted.resolveModelMock.mockReturnValueOnce({
      model: {
        provider: "github-copilot",
        id: "gpt-4.1",
      },
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: "ghu_test",
      source: "profile:github-copilot:default",
      mode: "token",
    });
    hoisted.resolveCopilotApiTokenMock.mockResolvedValueOnce({
      token: "copilot-runtime-token",
      expiresAt: Date.now() + 60_000,
      source: "cache:/tmp/copilot-token.json",
      baseUrl: "https://api.copilot.enterprise.example",
    });

    const result = await prepareSimpleCompletionModel({
      cfg: undefined,
      provider: "github-copilot",
      modelId: "gpt-4.1",
    });

    expect(result).not.toHaveProperty("error");
    if ("error" in result) {
      return;
    }
    expect(result.model).toEqual(
      expect.objectContaining({
        baseUrl: "https://api.copilot.enterprise.example",
      }),
    );
  });

  it("returns error when getApiKeyForModel throws", async () => {
    hoisted.getApiKeyForModelMock.mockRejectedValueOnce(new Error("Profile not found: copilot"));

    const result = await prepareSimpleCompletionModel({
      cfg: undefined,
      provider: "anthropic",
      modelId: "claude-opus-4-6",
    });

    expect(result).toEqual({
      error: 'Auth lookup failed for provider "anthropic": Profile not found: copilot',
    });
    expect(hoisted.setRuntimeApiKeyMock).not.toHaveBeenCalled();
  });

  it("applies local no-auth header override before returning model", async () => {
    hoisted.resolveModelMock.mockReturnValueOnce({
      model: {
        provider: "local-openai",
        id: "chat-local",
        api: "openai-completions",
      },
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: "custom-local",
      source: "models.providers.local-openai (synthetic local key)",
      mode: "api-key",
    });
    hoisted.applyLocalNoAuthHeaderOverrideMock.mockReturnValueOnce({
      provider: "local-openai",
      id: "chat-local",
      api: "openai-completions",
      headers: { Authorization: null },
    });

    const result = await prepareSimpleCompletionModel({
      cfg: undefined,
      provider: "local-openai",
      modelId: "chat-local",
    });

    expect(hoisted.applyLocalNoAuthHeaderOverrideMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "local-openai",
        id: "chat-local",
      }),
      expect.objectContaining({
        apiKey: "custom-local",
        source: "models.providers.local-openai (synthetic local key)",
        mode: "api-key",
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        model: expect.objectContaining({
          headers: expect.objectContaining({ Authorization: null }),
        }),
      }),
    );
  });

  it("applies provider runtime auth before storing simple-completion credentials", async () => {
    hoisted.resolveModelMock.mockReturnValueOnce({
      model: {
        provider: "amazon-bedrock-mantle",
        id: "anthropic.claude-opus-4-7",
        baseUrl: "https://bedrock-mantle.us-east-1.api.aws/anthropic",
      },
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: "__amazon_bedrock_mantle_iam__",
      source: "models.providers.amazon-bedrock-mantle.apiKey",
      mode: "api-key",
      profileId: "mantle",
    });
    hoisted.prepareProviderRuntimeAuthMock.mockResolvedValueOnce({
      apiKey: "bedrock-runtime-token",
      baseUrl: "https://bedrock-mantle.us-east-1.api.aws/anthropic",
    });

    const result = await prepareSimpleCompletionModel({
      cfg: undefined,
      provider: "amazon-bedrock-mantle",
      modelId: "anthropic.claude-opus-4-7",
      agentDir: "/tmp/openclaw-agent",
    });

    expect(hoisted.prepareProviderRuntimeAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "amazon-bedrock-mantle",
        workspaceDir: "/tmp/openclaw-agent",
        context: expect.objectContaining({
          apiKey: "__amazon_bedrock_mantle_iam__",
          authMode: "api-key",
          modelId: "anthropic.claude-opus-4-7",
          profileId: "mantle",
        }),
      }),
    );
    expect(hoisted.setRuntimeApiKeyMock).toHaveBeenCalledWith(
      "amazon-bedrock-mantle",
      "bedrock-runtime-token",
    );
    expect(result).toEqual(
      expect.objectContaining({
        model: expect.objectContaining({
          baseUrl: "https://bedrock-mantle.us-east-1.api.aws/anthropic",
        }),
        auth: expect.objectContaining({
          apiKey: "bedrock-runtime-token",
        }),
      }),
    );
  });

  it("omits synthetic request-auth markers from simple completion auth", async () => {
    const requestTransportSymbol = Symbol.for("openclaw.modelProviderRequestTransport");
    hoisted.resolveModelMock.mockReturnValueOnce({
      model: {
        provider: "plamo",
        id: "plamo-3.0-prime-beta",
        api: "openai-completions",
        baseUrl: "https://proxy.example.test/v1",
        headers: {
          "X-Proxy-Token": "proxy-token",
        },
        [requestTransportSymbol]: {
          headers: {
            "X-Proxy-Token": "proxy-token",
          },
        },
      },
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: "plamo-request-auth",
      source: "models.providers.plamo.request (synthetic request auth)",
      mode: "api-key",
    });

    const result = await prepareSimpleCompletionModel({
      cfg: undefined,
      provider: "plamo",
      modelId: "plamo-3.0-prime-beta",
    });

    expect(hoisted.setRuntimeApiKeyMock).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        auth: expect.objectContaining({
          apiKey: undefined,
          source: "models.providers.plamo.request (synthetic request auth)",
          mode: "api-key",
        }),
      }),
    );
  });

  it("keeps real api keys when auth-like request headers are additive", async () => {
    const requestTransportSymbol = Symbol.for("openclaw.modelProviderRequestTransport");
    hoisted.resolveModelMock.mockReturnValueOnce({
      model: {
        provider: "plamo",
        id: "plamo-3.0-prime-beta",
        api: "openai-completions",
        baseUrl: "https://proxy.example.test/v1",
        headers: {
          "X-Proxy-Token": "proxy-token",
        },
        [requestTransportSymbol]: {
          headers: {
            "X-Proxy-Token": "proxy-token",
          },
        },
      },
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: "sk-real-key",
      source: "env:PLAMO_API_KEY",
      mode: "api-key",
    });

    const result = await prepareSimpleCompletionModel({
      cfg: undefined,
      provider: "plamo",
      modelId: "plamo-3.0-prime-beta",
    });

    expect(hoisted.setRuntimeApiKeyMock).toHaveBeenCalledWith("plamo", "sk-real-key");
    expect(result).toEqual(
      expect.objectContaining({
        auth: expect.objectContaining({
          apiKey: "sk-real-key",
          source: "env:PLAMO_API_KEY",
          mode: "api-key",
        }),
      }),
    );
  });

  it("keeps real api keys when request transport headers are non-auth metadata", async () => {
    const requestTransportSymbol = Symbol.for("openclaw.modelProviderRequestTransport");
    hoisted.resolveModelMock.mockReturnValueOnce({
      model: {
        provider: "plamo",
        id: "plamo-3.0-prime-beta",
        api: "openai-completions",
        baseUrl: "https://proxy.example.test/v1",
        headers: {
          "X-Tenant": "tenant-a",
        },
        [requestTransportSymbol]: {
          headers: {
            "X-Tenant": "tenant-a",
          },
        },
      },
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: "sk-real-key",
      source: "env:PLAMO_API_KEY",
      mode: "api-key",
    });

    const result = await prepareSimpleCompletionModel({
      cfg: undefined,
      provider: "plamo",
      modelId: "plamo-3.0-prime-beta",
    });

    expect(hoisted.setRuntimeApiKeyMock).toHaveBeenCalledWith("plamo", "sk-real-key");
    expect(result).toEqual(
      expect.objectContaining({
        auth: expect.objectContaining({
          apiKey: "sk-real-key",
          source: "env:PLAMO_API_KEY",
          mode: "api-key",
        }),
      }),
    );
  });

  it("omits synthetic request-auth markers when auth is carried by model headers alone", async () => {
    hoisted.resolveModelMock.mockReturnValueOnce({
      model: {
        provider: "plamo",
        id: "plamo-3.0-prime-beta",
        api: "openai-completions",
        baseUrl: "https://proxy.example.test/v1",
        headers: {
          Authorization: "Bearer proxy-token",
        },
      },
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: "plamo-request-auth",
      source: "models.providers.plamo.request (synthetic request auth)",
      mode: "api-key",
    });

    const result = await prepareSimpleCompletionModel({
      cfg: undefined,
      provider: "plamo",
      modelId: "plamo-3.0-prime-beta",
    });

    expect(hoisted.setRuntimeApiKeyMock).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        auth: expect.objectContaining({
          apiKey: undefined,
          source: "models.providers.plamo.request (synthetic request auth)",
          mode: "api-key",
        }),
      }),
    );
  });

  it("keeps real api keys when auth-like model headers are additive", async () => {
    hoisted.resolveModelMock.mockReturnValueOnce({
      model: {
        provider: "plamo",
        id: "plamo-3.0-prime-beta",
        api: "openai-completions",
        baseUrl: "https://proxy.example.test/v1",
        headers: {
          Authorization: "Bearer proxy-token",
        },
      },
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: "sk-real-key",
      source: "env:PLAMO_API_KEY",
      mode: "api-key",
    });

    const result = await prepareSimpleCompletionModel({
      cfg: undefined,
      provider: "plamo",
      modelId: "plamo-3.0-prime-beta",
    });

    expect(hoisted.setRuntimeApiKeyMock).toHaveBeenCalledWith("plamo", "sk-real-key");
    expect(result).toEqual(
      expect.objectContaining({
        auth: expect.objectContaining({
          apiKey: "sk-real-key",
          source: "env:PLAMO_API_KEY",
          mode: "api-key",
        }),
      }),
    );
  });

  it("omits real api keys when request auth explicitly replaces provider auth", async () => {
    const requestTransportSymbol = Symbol.for("openclaw.modelProviderRequestTransport");
    hoisted.resolveModelMock.mockReturnValueOnce({
      model: {
        provider: "plamo",
        id: "plamo-3.0-prime-beta",
        api: "openai-completions",
        baseUrl: "https://proxy.example.test/v1",
        [requestTransportSymbol]: {
          auth: {
            mode: "header",
            headerName: "X-Proxy-Token",
            value: "proxy-token",
          },
        },
      },
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: "sk-real-key",
      source: "env:PLAMO_API_KEY",
      mode: "api-key",
    });

    const result = await prepareSimpleCompletionModel({
      cfg: undefined,
      provider: "plamo",
      modelId: "plamo-3.0-prime-beta",
    });

    expect(hoisted.setRuntimeApiKeyMock).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        auth: expect.objectContaining({
          apiKey: undefined,
          source: "env:PLAMO_API_KEY",
          mode: "api-key",
        }),
      }),
    );
  });
});

describe("completeWithPreparedSimpleCompletionModel", () => {
  it("routes request-authenticated models through the provider-owned stream", async () => {
    const requestTransportSymbol = Symbol.for("openclaw.modelProviderRequestTransport");
    const model = {
      provider: "plamo",
      id: "plamo-3.0-prime-beta",
      api: "openai-completions",
      baseUrl: "https://proxy.example.test/v1",
      headers: {
        "X-Proxy-Token": "proxy-token",
      },
      [requestTransportSymbol]: {
        headers: {
          "X-Proxy-Token": "proxy-token",
        },
      },
    };
    const context = {
      messages: [{ role: "user", content: "title", timestamp: 1 }],
    };
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      api: "openai-completions",
      provider: "plamo",
      model: "plamo-3.0-prime-beta",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 1,
    };
    const stream = {
      result: vi.fn(async () => message),
      [Symbol.asyncIterator]: async function* () {},
    };
    const streamFn = vi.fn(() => stream);
    hoisted.registerProviderStreamForModelMock.mockReturnValueOnce(streamFn);

    const result = await completeWithPreparedSimpleCompletionModel({
      model: model as never,
      auth: {
        apiKey: undefined,
        source: "models.providers.plamo.request (synthetic request auth)",
        mode: "api-key",
      },
      context: context as never,
      options: { maxTokens: 12 },
    });

    expect(result).toBe(message);
    expect(hoisted.registerProviderStreamForModelMock).toHaveBeenCalledWith({
      model,
    });
    expect(streamFn).toHaveBeenCalledWith(model, context, {
      maxTokens: 12,
      apiKey: undefined,
    });
    expect(stream.result).toHaveBeenCalledTimes(1);
    expect(hoisted.completeMock).not.toHaveBeenCalled();
  });

  it("keeps normal api-key completions on the built-in completion path", async () => {
    const model = {
      provider: "plamo",
      id: "plamo-3.0-prime-beta",
      api: "openai-completions",
      baseUrl: "https://api.platform.preferredai.jp/v1",
    };
    const context = {
      messages: [{ role: "user", content: "title", timestamp: 1 }],
    };

    const result = await completeWithPreparedSimpleCompletionModel({
      model: model as never,
      auth: {
        apiKey: "sk-real-key",
        source: "env:PLAMO_API_KEY",
        mode: "api-key",
      },
      context: context as never,
      options: { maxTokens: 12 },
    });

    expect(result).toBe("ok");
    expect(hoisted.registerProviderStreamForModelMock).not.toHaveBeenCalled();
    expect(hoisted.completeMock).toHaveBeenCalledWith(model, context, {
      maxTokens: 12,
      apiKey: "sk-real-key",
    });
  });
});
