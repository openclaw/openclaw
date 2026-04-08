import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../test/helpers/plugins/plugin-api.js";
import plugin from "./index.js";

const promptAndConfigureOllamaMock = vi.hoisted(() =>
  vi.fn(async () => ({
    config: {
      models: {
        providers: {
          ollama: {
            baseUrl: "http://127.0.0.1:11434",
            api: "ollama",
            models: [],
          },
        },
      },
    },
  })),
);
const ensureOllamaModelPulledMock = vi.hoisted(() => vi.fn(async () => {}));
const buildOllamaProviderMock = vi.hoisted(() => vi.fn());
const innerStreamFnMock = vi.hoisted(() =>
  vi.fn((_m: unknown, _ctx: unknown, _opts?: { apiKey?: string }) => ({}) as never),
);
const resolveEnvApiKeyMock = vi.hoisted(() => vi.fn(() => null as { apiKey: string } | null));

vi.mock("./api.js", () => ({
  promptAndConfigureOllama: promptAndConfigureOllamaMock,
  ensureOllamaModelPulled: ensureOllamaModelPulledMock,
  configureOllamaNonInteractive: vi.fn(),
  buildOllamaProvider: buildOllamaProviderMock,
}));

vi.mock("./src/stream.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./src/stream.js")>();
  return {
    ...actual,
    createConfiguredOllamaStreamFn: () => innerStreamFnMock,
  };
});

vi.mock("openclaw/plugin-sdk/provider-auth", async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig };
});

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, resolveEnvApiKey: resolveEnvApiKeyMock };
});

beforeEach(() => {
  promptAndConfigureOllamaMock.mockClear();
  ensureOllamaModelPulledMock.mockClear();
  buildOllamaProviderMock.mockReset();
  innerStreamFnMock.mockClear();
  resolveEnvApiKeyMock.mockReset();
  resolveEnvApiKeyMock.mockReturnValue(null);
});

function registerProvider() {
  return registerProviderWithPluginConfig({});
}

function registerProviderWithPluginConfig(pluginConfig: Record<string, unknown>) {
  const registerProviderMock = vi.fn();

  plugin.register(
    createTestPluginApi({
      id: "ollama",
      name: "Ollama",
      source: "test",
      config: {},
      pluginConfig,
      runtime: {} as never,
      registerProvider: registerProviderMock,
    }),
  );

  expect(registerProviderMock).toHaveBeenCalledTimes(1);
  return registerProviderMock.mock.calls[0]?.[0];
}

describe("ollama plugin", () => {
  it("does not preselect a default model during provider auth setup", async () => {
    const provider = registerProvider();

    const result = await provider.auth[0].run({
      config: {},
      prompter: {} as never,
      isRemote: false,
      openUrl: vi.fn(async () => undefined),
    });

    expect(promptAndConfigureOllamaMock).toHaveBeenCalledWith({
      cfg: {},
      prompter: {},
      isRemote: false,
      openUrl: expect.any(Function),
    });
    expect(result.configPatch).toEqual({
      models: {
        providers: {
          ollama: {
            baseUrl: "http://127.0.0.1:11434",
            api: "ollama",
            models: [],
          },
        },
      },
    });
    expect(result.defaultModel).toBeUndefined();
  });

  it("pulls the model the user actually selected", async () => {
    const provider = registerProvider();
    const config = {
      models: {
        providers: {
          ollama: {
            baseUrl: "http://127.0.0.1:11434",
            models: [],
          },
        },
      },
    };
    const prompter = {} as never;

    await provider.onModelSelected?.({
      config,
      model: "ollama/gemma4",
      prompter,
    });

    expect(ensureOllamaModelPulledMock).toHaveBeenCalledWith({
      config,
      model: "ollama/gemma4",
      prompter,
    });
  });

  it("skips ambient discovery when plugin discovery is disabled", async () => {
    const provider = registerProviderWithPluginConfig({ discovery: { enabled: false } });

    const result = await provider.discovery.run({
      config: {},
      env: {},
      resolveProviderApiKey: () => ({ apiKey: "", discoveryApiKey: "" }),
    } as never);

    expect(result).toBeNull();
    expect(buildOllamaProviderMock).not.toHaveBeenCalled();
  });

  it("keeps empty default-ish provider stubs quiet", async () => {
    const provider = registerProvider();
    buildOllamaProviderMock.mockResolvedValueOnce({
      baseUrl: "http://127.0.0.1:11434",
      api: "ollama",
      models: [],
    });

    const result = await provider.discovery.run({
      config: {
        models: {
          providers: {
            ollama: {
              baseUrl: "http://127.0.0.1:11434",
              api: "ollama",
              models: [],
            },
          },
        },
      },
      env: { NODE_ENV: "development" },
      resolveProviderApiKey: () => ({ apiKey: "" }),
    } as never);

    expect(result).toBeNull();
    expect(buildOllamaProviderMock).toHaveBeenCalledWith("http://127.0.0.1:11434", {
      quiet: true,
    });
  });

  it("treats non-default baseUrl as explicit discovery config", async () => {
    const provider = registerProvider();
    buildOllamaProviderMock.mockResolvedValueOnce({
      baseUrl: "http://remote-ollama:11434",
      api: "ollama",
      models: [],
    });

    const result = await provider.discovery.run({
      config: {
        models: {
          providers: {
            ollama: {
              baseUrl: "http://remote-ollama:11434",
              api: "ollama",
              models: [],
            },
          },
        },
      },
      env: { NODE_ENV: "development" },
      resolveProviderApiKey: () => ({ apiKey: "" }),
    } as never);

    expect(result).toBeNull();
    expect(buildOllamaProviderMock).toHaveBeenCalledWith("http://remote-ollama:11434", {
      quiet: false,
    });
  });

  it("keeps stored ollama-local marker auth on the quiet ambient path", async () => {
    const provider = registerProvider();
    buildOllamaProviderMock.mockResolvedValueOnce({
      baseUrl: "http://127.0.0.1:11434",
      api: "ollama",
      models: [],
    });

    const result = await provider.discovery.run({
      config: {},
      env: { NODE_ENV: "development" },
      resolveProviderApiKey: () => ({ apiKey: "ollama-local" }),
    } as never);

    expect(result).toMatchObject({
      provider: {
        baseUrl: "http://127.0.0.1:11434",
        api: "ollama",
        apiKey: "ollama-local",
        models: [],
      },
    });
    expect(buildOllamaProviderMock).toHaveBeenCalledWith(undefined, {
      quiet: true,
    });
  });

  it("does not mint synthetic auth for empty default-ish provider stubs", () => {
    const provider = registerProvider();

    const auth = provider.resolveSyntheticAuth?.({
      providerConfig: {
        baseUrl: "http://127.0.0.1:11434",
        api: "ollama",
        models: [],
      },
    });

    expect(auth).toBeUndefined();
  });

  it("wraps OpenAI-compatible payloads with num_ctx for Ollama compat routes", () => {
    const provider = registerProvider();
    let payloadSeen: Record<string, unknown> | undefined;
    const baseStreamFn = vi.fn((_model, _context, options) => {
      const payload: Record<string, unknown> = { options: { temperature: 0.1 } };
      options?.onPayload?.(payload, _model);
      payloadSeen = payload;
      return {} as never;
    });

    const wrapped = provider.wrapStreamFn?.({
      config: {
        models: {
          providers: {
            ollama: {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:11434/v1",
              models: [],
            },
          },
        },
      },
      provider: "ollama",
      modelId: "qwen3:32b",
      model: {
        api: "openai-completions",
        provider: "ollama",
        id: "qwen3:32b",
        baseUrl: "http://127.0.0.1:11434/v1",
        contextWindow: 202_752,
      },
      streamFn: baseStreamFn,
    });

    expect(typeof wrapped).toBe("function");
    void wrapped?.({} as never, {} as never, {});
    expect(baseStreamFn).toHaveBeenCalledTimes(1);
    expect((payloadSeen?.options as Record<string, unknown> | undefined)?.num_ctx).toBe(202752);
  });

  it("owns replay policy for OpenAI-compatible Ollama routes only", () => {
    const provider = registerProvider();

    expect(
      provider.buildReplayPolicy?.({
        provider: "ollama",
        modelApi: "openai-completions",
        modelId: "qwen3:32b",
      } as never),
    ).toMatchObject({
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      applyAssistantFirstOrderingFix: true,
      validateGeminiTurns: true,
      validateAnthropicTurns: true,
    });

    expect(
      provider.buildReplayPolicy?.({
        provider: "ollama",
        modelApi: "openai-responses",
        modelId: "qwen3:32b",
      } as never),
    ).toMatchObject({
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      applyAssistantFirstOrderingFix: false,
      validateGeminiTurns: false,
      validateAnthropicTurns: false,
    });

    expect(
      provider.buildReplayPolicy?.({
        provider: "ollama",
        modelApi: "ollama",
        modelId: "qwen3.5:9b",
      } as never),
    ).toBeUndefined();
  });

  it("routes createStreamFn to the correct provider baseUrl for ollama2", () => {
    const provider = registerProvider();
    const config = {
      models: {
        providers: {
          ollama: {
            api: "ollama",
            baseUrl: "http://127.0.0.1:11434",
            models: [],
          },
          ollama2: {
            api: "ollama",
            baseUrl: "http://127.0.0.1:11435",
            models: [],
          },
        },
      },
    };
    const model = { id: "llama3.2", provider: "ollama2", baseUrl: undefined };

    provider.createStreamFn?.({ config, model, provider: "ollama2" } as never);

    expect(resolveEnvApiKeyMock).not.toHaveBeenCalled();
  });

  it("injects the selected provider's API key instead of hardcoded ollama", () => {
    resolveEnvApiKeyMock.mockReturnValue(null);
    const provider = registerProvider();
    const streamFn = provider.createStreamFn?.({
      config: {
        models: {
          providers: {
            ollama: {
              api: "ollama",
              baseUrl: "http://127.0.0.1:11434",
              apiKey: "sk-wrong-provider",
            },
            ollama2: {
              api: "ollama",
              baseUrl: "http://127.0.0.1:11435",
              apiKey: "sk-right-provider",
            },
          },
        },
      },
      model: { id: "llama3.2", provider: "ollama2", api: "ollama" },
      provider: "ollama2",
    } as never);

    expect(streamFn).not.toBe(innerStreamFnMock);
    innerStreamFnMock.mockClear();
    void streamFn?.({} as never, {} as never, {});
    expect(innerStreamFnMock).toHaveBeenCalledTimes(1);
    const passedOpts = innerStreamFnMock.mock.calls[0]?.[2];
    expect(passedOpts?.apiKey).toBe("sk-right-provider");
  });

  it("uses ollama provider baseUrl when provider is ollama (backward compat)", () => {
    const provider = registerProvider();
    const config = {
      models: {
        providers: {
          ollama: {
            api: "ollama",
            baseUrl: "http://127.0.0.1:11434",
            models: [],
          },
          ollama2: {
            api: "ollama",
            baseUrl: "http://127.0.0.1:11435",
            models: [],
          },
        },
      },
    };
    const model = { id: "llama3.2", provider: "ollama", baseUrl: undefined };

    provider.createStreamFn?.({ config, model, provider: "ollama" } as never);

    expect(resolveEnvApiKeyMock).not.toHaveBeenCalled();
  });

  it("wraps native Ollama payloads with top-level think=false when thinking is off", () => {
    const provider = registerProvider();
    let payloadSeen: Record<string, unknown> | undefined;
    const baseStreamFn = vi.fn((_model, _context, options) => {
      const payload: Record<string, unknown> = {
        messages: [],
        options: { num_ctx: 65536 },
        stream: true,
      };
      options?.onPayload?.(payload, _model);
      payloadSeen = payload;
      return {} as never;
    });

    const wrapped = provider.wrapStreamFn?.({
      config: {
        models: {
          providers: {
            ollama: {
              api: "ollama",
              baseUrl: "http://127.0.0.1:11434",
              models: [],
            },
          },
        },
      },
      provider: "ollama",
      modelId: "qwen3.5:9b",
      thinkingLevel: "off",
      model: {
        api: "ollama",
        provider: "ollama",
        id: "qwen3.5:9b",
        baseUrl: "http://127.0.0.1:11434",
        contextWindow: 131_072,
      },
      streamFn: baseStreamFn,
    });

    expect(typeof wrapped).toBe("function");
    void wrapped?.(
      {
        api: "ollama",
        provider: "ollama",
        id: "qwen3.5:9b",
      } as never,
      {} as never,
      {},
    );
    expect(baseStreamFn).toHaveBeenCalledTimes(1);
    expect(payloadSeen?.think).toBe(false);
    expect((payloadSeen?.options as Record<string, unknown> | undefined)?.think).toBeUndefined();
  });

  it("wraps native Ollama payloads with top-level think=true when thinking is enabled", () => {
    const provider = registerProvider();
    let payloadSeen: Record<string, unknown> | undefined;
    const baseStreamFn = vi.fn((_model, _context, options) => {
      const payload: Record<string, unknown> = {
        messages: [],
        options: { num_ctx: 65536 },
        stream: true,
      };
      options?.onPayload?.(payload, _model);
      payloadSeen = payload;
      return {} as never;
    });

    const wrapped = provider.wrapStreamFn?.({
      config: {
        models: {
          providers: {
            ollama: {
              api: "ollama",
              baseUrl: "http://127.0.0.1:11434",
              models: [],
            },
          },
        },
      },
      provider: "ollama",
      modelId: "qwen3.5:9b",
      thinkingLevel: "low",
      model: {
        api: "ollama",
        provider: "ollama",
        id: "qwen3.5:9b",
        baseUrl: "http://127.0.0.1:11434",
        contextWindow: 131_072,
      },
      streamFn: baseStreamFn,
    });

    expect(typeof wrapped).toBe("function");
    void wrapped?.(
      {
        api: "ollama",
        provider: "ollama",
        id: "qwen3.5:9b",
      } as never,
      {} as never,
      {},
    );
    expect(baseStreamFn).toHaveBeenCalledTimes(1);
    expect(payloadSeen?.think).toBe(true);
    expect((payloadSeen?.options as Record<string, unknown> | undefined)?.think).toBeUndefined();
  });

  it("does not set think param when thinkingLevel is undefined", () => {
    const provider = registerProvider();
    let payloadSeen: Record<string, unknown> | undefined;
    const baseStreamFn = vi.fn((_model, _context, options) => {
      const payload: Record<string, unknown> = {
        messages: [],
        options: { num_ctx: 65536 },
        stream: true,
      };
      options?.onPayload?.(payload, _model);
      payloadSeen = payload;
      return {} as never;
    });

    const wrapped = provider.wrapStreamFn?.({
      config: {
        models: {
          providers: {
            ollama: {
              api: "ollama",
              baseUrl: "http://127.0.0.1:11434",
              models: [],
            },
          },
        },
      },
      provider: "ollama",
      modelId: "qwen3.5:9b",
      thinkingLevel: undefined,
      model: {
        api: "ollama",
        provider: "ollama",
        id: "qwen3.5:9b",
        baseUrl: "http://127.0.0.1:11434",
        contextWindow: 131_072,
      },
      streamFn: baseStreamFn,
    });

    expect(typeof wrapped).toBe("function");
    void wrapped?.(
      {
        api: "ollama",
        provider: "ollama",
        id: "qwen3.5:9b",
      } as never,
      {} as never,
      {},
    );
    expect(baseStreamFn).toHaveBeenCalledTimes(1);
    expect(payloadSeen?.think).toBeUndefined();
  });

  describe("resolveSyntheticAuth", () => {
    it("returns synthetic auth for local/private HTTP endpoints", () => {
      const provider = registerProvider();
      for (const baseUrl of [
        "http://192.168.4.50:11434",
        "http://10.0.0.5:11434",
        "http://gpu-node-server:11434",
        "http://myhost.local:11434",
      ]) {
        const result = provider.resolveSyntheticAuth?.({
          providerConfig: { baseUrl, api: "ollama", models: [] },
        });
        expect(result).toEqual(
          expect.objectContaining({ apiKey: "ollama-local", mode: "api-key" }),
        );
      }
    });

    it("returns synthetic auth for localhost HTTP endpoints when explicitly configured", () => {
      const provider = registerProvider();
      for (const baseUrl of ["http://localhost:11434", "http://127.0.0.1:11434"]) {
        const result = provider.resolveSyntheticAuth?.({
          providerConfig: { baseUrl, api: "ollama", models: [{ id: "test" }] },
        });
        expect(result).toEqual(
          expect.objectContaining({ apiKey: "ollama-local", mode: "api-key" }),
        );
      }
    });

    it("returns undefined for HTTPS endpoints on public hosts", () => {
      const provider = registerProvider();
      for (const baseUrl of [
        "https://ollama.com",
        "https://my-ollama.example.com:11434",
        "https://cloud.ollama.ai",
        "https://10.example.com:11434",
        "https://[2001:db8::1]:11434",
      ]) {
        const result = provider.resolveSyntheticAuth?.({
          providerConfig: { baseUrl, api: "ollama", models: [] },
        });
        expect(result).toBeUndefined();
      }
    });

    it("returns synthetic auth for HTTPS endpoints on private/local hosts", () => {
      const provider = registerProvider();
      for (const baseUrl of [
        "https://localhost:11434",
        "https://192.168.1.100:11434",
        "https://10.0.0.5:11434",
        "https://ollama.local:443",
        "https://ollama.internal:443",
        "https://gpu-node-server:11434",
      ]) {
        const result = provider.resolveSyntheticAuth?.({
          providerConfig: { baseUrl, api: "ollama", models: [] },
        });
        expect(result).toEqual(
          expect.objectContaining({ apiKey: "ollama-local", mode: "api-key" }),
        );
      }
    });

    it("returns synthetic auth when no baseUrl is configured", () => {
      const provider = registerProvider();
      const result = provider.resolveSyntheticAuth?.({
        providerConfig: { api: "ollama", models: [{ id: "test" }] },
      });
      expect(result).toEqual(expect.objectContaining({ apiKey: "ollama-local" }));
    });

    it("returns undefined when no provider config is present", () => {
      const provider = registerProvider();
      const result = provider.resolveSyntheticAuth?.({
        providerConfig: undefined,
      });
      expect(result).toBeUndefined();
    });
  });

  describe("createStreamFn key injection", () => {
    it("returns inner stream function unwrapped when apiKey is the default marker", () => {
      resolveEnvApiKeyMock.mockReturnValue(null);
      const provider = registerProvider();
      const streamFn = provider.createStreamFn?.({
        config: {
          models: {
            providers: {
              ollama: { baseUrl: "http://localhost:11434", apiKey: "ollama-local" },
            },
          },
        },
        model: { id: "test", provider: "ollama", api: "ollama" },
      });
      expect(streamFn).toBe(innerStreamFnMock);
    });

    it("injects env-var resolved key into stream options", () => {
      resolveEnvApiKeyMock.mockReturnValue({ apiKey: "resolved-cloud-key" });
      const provider = registerProvider();
      const streamFn = provider.createStreamFn?.({
        config: {
          models: {
            providers: {
              ollama: { baseUrl: "https://ollama.com", apiKey: "OLLAMA_API_KEY" },
            },
          },
        },
        model: { id: "test", provider: "ollama", api: "ollama" },
        provider: "ollama",
      });
      expect(streamFn).not.toBe(innerStreamFnMock);

      innerStreamFnMock.mockClear();
      void streamFn?.({} as never, {} as never, {});
      expect(innerStreamFnMock).toHaveBeenCalledTimes(1);
      const passedOpts = innerStreamFnMock.mock.calls[0]?.[2];
      expect(passedOpts?.apiKey).toBe("resolved-cloud-key");
    });

    it("falls back to inline key when resolveEnvApiKey returns null", () => {
      resolveEnvApiKeyMock.mockReturnValue(null);
      const provider = registerProvider();
      const streamFn = provider.createStreamFn?.({
        config: {
          models: {
            providers: {
              ollama: { baseUrl: "https://ollama.com", apiKey: "sk-my-inline-token" },
            },
          },
        },
        model: { id: "test", provider: "ollama", api: "ollama" },
        provider: "ollama",
      });
      expect(streamFn).not.toBe(innerStreamFnMock);

      innerStreamFnMock.mockClear();
      void streamFn?.({} as never, {} as never, {});
      expect(innerStreamFnMock).toHaveBeenCalledTimes(1);
      const passedOpts = innerStreamFnMock.mock.calls[0]?.[2];
      expect(passedOpts?.apiKey).toBe("sk-my-inline-token");
    });

    it("does not inject unresolved env-var marker as a literal key", () => {
      resolveEnvApiKeyMock.mockReturnValue(null);
      const provider = registerProvider();
      const streamFn = provider.createStreamFn?.({
        config: {
          models: {
            providers: {
              ollama: { baseUrl: "https://ollama.com", apiKey: "OLLAMA_API_KEY" },
            },
          },
        },
        model: { id: "test", provider: "ollama", api: "ollama" },
        provider: "ollama",
      });
      // Env var unset + config is a known marker → should NOT inject the marker string
      expect(streamFn).toBe(innerStreamFnMock);
    });

    it("does not override an existing apiKey in options", () => {
      resolveEnvApiKeyMock.mockReturnValue({ apiKey: "resolved-cloud-key" });
      const provider = registerProvider();
      const streamFn = provider.createStreamFn?.({
        config: {
          models: {
            providers: {
              ollama: { baseUrl: "https://ollama.com", apiKey: "OLLAMA_API_KEY" },
            },
          },
        },
        model: { id: "test", provider: "ollama", api: "ollama" },
        provider: "ollama",
      });

      innerStreamFnMock.mockClear();
      void streamFn?.({} as never, {} as never, { apiKey: "caller-provided-key" } as never);
      expect(innerStreamFnMock).toHaveBeenCalledTimes(1);
      const passedOpts = innerStreamFnMock.mock.calls[0]?.[2];
      expect(passedOpts?.apiKey).toBe("caller-provided-key");
    });

    it("returns inner stream function unwrapped when no provider config is present", () => {
      resolveEnvApiKeyMock.mockReturnValue(null);
      const provider = registerProvider();
      const streamFn = provider.createStreamFn?.({
        config: {},
        model: { id: "test", provider: "ollama", api: "ollama" },
      });
      expect(streamFn).toBe(innerStreamFnMock);
    });
  });
});
