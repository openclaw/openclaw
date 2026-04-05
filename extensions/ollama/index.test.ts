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

vi.mock("./api.js", () => ({
  promptAndConfigureOllama: promptAndConfigureOllamaMock,
  ensureOllamaModelPulled: ensureOllamaModelPulledMock,
  configureOllamaNonInteractive: vi.fn(),
  buildOllamaProvider: buildOllamaProviderMock,
}));

beforeEach(() => {
  promptAndConfigureOllamaMock.mockClear();
  ensureOllamaModelPulledMock.mockClear();
  buildOllamaProviderMock.mockReset();
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
      model: "ollama/glm-4.7-flash",
      prompter,
    });

    expect(ensureOllamaModelPulledMock).toHaveBeenCalledWith({
      config,
      model: "ollama/glm-4.7-flash",
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
});
