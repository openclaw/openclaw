import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createModelProviderConfig } from "../test-support/model-provider-config.test-support.js";

describe("ollama lazy imports", () => {
  afterEach(() => {
    for (const moduleId of [
      "./src/memory-embedding-adapter.js",
      "./src/node-inference.js",
      "./src/setup.runtime.js",
      "./src/stream.runtime.js",
      "./src/web-search-provider.runtime.js",
      "./src/wsl2-crash-loop-check.js",
      "openclaw/plugin-sdk/runtime-env",
    ]) {
      vi.doUnmock(moduleId);
    }
    vi.resetModules();
  });

  it("loads optional runtime owners only on first use", async () => {
    const imports = { memory: 0, node: 0, setup: 0, stream: 0, web: 0, wsl: 0 };
    function mockRuntime(
      owner: keyof typeof imports,
      moduleId: string,
      load: () => Record<string, unknown>,
    ) {
      vi.doMock(moduleId, () => {
        imports[owner] += 1;
        return load();
      });
    }
    let streamParams: Record<string, unknown> | undefined;
    let wslChecks = 0;

    vi.doMock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => ({
      ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>()),
      isWSL2Sync: () => {
        wslChecks += 1;
        return false;
      },
    }));
    mockRuntime("memory", "./src/memory-embedding-adapter.js", () => ({
      ollamaMemoryEmbeddingProviderAdapter: {
        create: async () => ({ provider: null }),
      },
    }));
    mockRuntime("node", "./src/node-inference.js", () => ({
      createOllamaNodeHostCommands: () => [
        {
          command: "ollama.models",
          cap: "local-inference",
          handle: async () => JSON.stringify({ provider: "ollama", models: [] }),
        },
      ],
      createOllamaNodeInferenceTool: () => ({
        execute: async () => ({ content: [] }),
      }),
    }));
    mockRuntime("setup", "./src/setup.runtime.js", () => ({
      promptAndConfigureOllama: async () => ({ config: {} }),
    }));
    mockRuntime("stream", "./src/stream.runtime.js", () => ({
      createConfiguredOllamaStreamFn: (params: Record<string, unknown>) => {
        streamParams = params;
        return async () => ({ transport: "ollama" });
      },
    }));
    mockRuntime("web", "./src/web-search-provider.runtime.js", () => ({
      createOllamaWebSearchProvider: () => ({
        createTool: () => ({
          execute: async ({ query }: { query: string }) => ({ query, results: [] }),
        }),
      }),
    }));
    mockRuntime("wsl", "./src/wsl2-crash-loop-check.js", () => ({
      checkWsl2CrashLoopRisk: async () => {},
    }));

    const { default: ollamaPlugin } = await import("./index.js");
    const runtime = createPluginRuntimeMock();
    const api = createTestPluginApi({ id: "ollama", runtime });
    const embedding = vi.spyOn(api, "registerEmbeddingProvider");
    const media = vi.spyOn(api, "registerMediaUnderstandingProvider");
    const commands = vi.spyOn(api, "registerNodeHostCommand");
    const tools = vi.spyOn(api, "registerTool");
    const providers = vi.spyOn(api, "registerProvider");
    const webSearch = vi.spyOn(api, "registerWebSearchProvider");
    ollamaPlugin.register(api);
    await vi.waitFor(() => expect(wslChecks).toBe(1));
    const nodeInferenceTool = tools.mock.calls[0]?.[0];
    if (
      !nodeInferenceTool ||
      typeof nodeInferenceTool === "function" ||
      "contextVersion" in nodeInferenceTool
    ) {
      throw new Error("Expected the registered node inference tool");
    }
    expect(nodeInferenceTool.name).toBe("node_inference");

    expect(imports).toEqual({ memory: 0, node: 0, setup: 0, stream: 0, web: 0, wsl: 0 });
    expect(media.mock.calls[0]?.[0]).toMatchObject({ id: "ollama", capabilities: ["image"] });

    await expect(embedding.mock.calls[0]?.[0].create({} as never)).resolves.toEqual({
      provider: null,
    });
    await expect(commands.mock.calls[0]?.[0].handle()).resolves.toBe(
      JSON.stringify({ provider: "ollama", models: [] }),
    );
    await expect(nodeInferenceTool?.execute("call-1", {}, undefined)).resolves.toEqual({
      content: [],
    });
    await expect(
      webSearch.mock.calls[0]?.[0]
        .createTool({ config: {} } as never)
        ?.execute({ query: "openclaw" }),
    ).resolves.toEqual({ query: "openclaw", results: [] });

    const localProvider = providers.mock.calls
      .map(([provider]) => provider)
      .find(({ id }) => id === "ollama");
    await expect(
      localProvider?.auth[0]?.run({ config: {}, prompter: {} } as never),
    ).resolves.toMatchObject({ configPatch: {} });
    const streamFn = localProvider?.createStreamFn?.({
      config: createModelProviderConfig({
        "ollama-gpu": { api: "ollama", baseUrl: "http://127.0.0.1:11435", models: [] },
      }),
      model: { api: "ollama", id: "qwen3:32b", provider: "ollama-gpu" },
      provider: "ollama-gpu",
    } as never);
    await expect(streamFn?.({} as never, {} as never, {})).resolves.toEqual({
      transport: "ollama",
    });
    expect(streamParams).toMatchObject({
      providerBaseUrl: "http://127.0.0.1:11435",
      localService: {
        providerId: "ollama-gpu",
        acquire: runtime.llm.acquireLocalService,
      },
    });

    expect(imports).toEqual({ memory: 1, node: 1, setup: 1, stream: 1, web: 1, wsl: 0 });
  });
});
