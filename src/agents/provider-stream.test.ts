import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const resolveProviderStreamFn = vi.fn();
const ensureCustomApiRegistered = vi.fn();
const createBoundaryAwareStreamFnForModel = vi.fn();
const createTransportAwareStreamFnForModel = vi.fn();

vi.mock("../plugins/provider-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/provider-runtime.js")>(
    "../plugins/provider-runtime.js",
  );
  return {
    ...actual,
    resolveProviderStreamFn,
  };
});

vi.mock("./custom-api-registry.js", () => ({
  ensureCustomApiRegistered,
}));

vi.mock("./provider-transport-stream.js", () => ({
  createBoundaryAwareStreamFnForModel,
  createTransportAwareStreamFnForModel,
}));

let registerProviderStreamForModel: typeof import("./provider-stream.js").registerProviderStreamForModel;

describe("registerProviderStreamForModel", () => {
  beforeAll(async () => {
    ({ registerProviderStreamForModel } = await import("./provider-stream.js"));
  });

  beforeEach(() => {
    resolveProviderStreamFn.mockReset();
    ensureCustomApiRegistered.mockReset();
    createBoundaryAwareStreamFnForModel.mockReset();
    createTransportAwareStreamFnForModel.mockReset();
  });

  it("registers a boundary-aware Ollama api handler while returning the provider-owned stream", () => {
    const providerStream = vi.fn();
    const boundaryAwareStream = vi.fn();
    resolveProviderStreamFn.mockReturnValue(providerStream);
    createBoundaryAwareStreamFnForModel.mockReturnValue(boundaryAwareStream);

    const model = {
      id: "qwen3.5:27b",
      name: "Qwen",
      api: "ollama",
      provider: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 262144,
      maxTokens: 16384,
    } as const;

    const result = registerProviderStreamForModel({ model });

    expect(createBoundaryAwareStreamFnForModel).toHaveBeenCalledWith(model);
    expect(createTransportAwareStreamFnForModel).not.toHaveBeenCalled();
    expect(ensureCustomApiRegistered).toHaveBeenCalledWith("ollama", boundaryAwareStream);
    expect(result).toBe(providerStream);
  });

  it("falls back to the boundary-aware Ollama stream for custom provider ids", () => {
    const boundaryAwareStream = vi.fn();
    resolveProviderStreamFn.mockReturnValue(undefined);
    createBoundaryAwareStreamFnForModel.mockReturnValue(boundaryAwareStream);

    const model = {
      id: "qwen3.5:27b",
      name: "Qwen",
      api: "ollama",
      provider: "ollama-5090",
      baseUrl: "http://127.0.0.1:11435",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 262144,
      maxTokens: 16384,
    } as const;

    const result = registerProviderStreamForModel({ model });

    expect(createBoundaryAwareStreamFnForModel).toHaveBeenCalledWith(model);
    expect(createTransportAwareStreamFnForModel).not.toHaveBeenCalled();
    expect(ensureCustomApiRegistered).toHaveBeenCalledWith("ollama", boundaryAwareStream);
    expect(result).toBe(boundaryAwareStream);
  });

  it("still uses transport-aware fallbacks for non-Ollama providers", () => {
    const transportAwareStream = vi.fn();
    resolveProviderStreamFn.mockReturnValue(undefined);
    createTransportAwareStreamFnForModel.mockReturnValue(transportAwareStream);

    const model = {
      id: "gpt-5.4",
      name: "GPT-5.4",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
    } as const;

    const result = registerProviderStreamForModel({ model });

    expect(createBoundaryAwareStreamFnForModel).not.toHaveBeenCalled();
    expect(createTransportAwareStreamFnForModel).toHaveBeenCalledWith(model);
    expect(ensureCustomApiRegistered).toHaveBeenCalledWith("openai-responses", transportAwareStream);
    expect(result).toBe(transportAwareStream);
  });
});
