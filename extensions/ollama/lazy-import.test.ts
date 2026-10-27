import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("ollama lazy imports", () => {
  const mockedModules: string[] = [];
  afterEach(() => {
    for (const moduleId of mockedModules.splice(0)) {
      vi.doUnmock(moduleId);
    }
    vi.resetModules();
  });

  it("loads optional runtime owners only on first use", async () => {
    const imports = { memory: 0, node: 0, setup: 0, stream: 0, web: 0, wsl: 0 };
    function mockRuntime(
      owner: keyof typeof imports,
      moduleId: string,
      exports: Record<string, unknown>,
    ) {
      mockedModules.push(moduleId);
      vi.doMock(moduleId, () => {
        imports[owner] += 1;
        return exports;
      });
    }
    const isWSL2Sync = vi.fn(() => false);

    mockedModules.push("openclaw/plugin-sdk/runtime-env");
    vi.doMock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => ({
      ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>()),
      isWSL2Sync,
    }));
    mockRuntime("memory", "./src/memory-embedding-adapter.js", {
      ollamaMemoryEmbeddingProviderAdapter: { create: async () => ({ provider: null }) },
    });
    mockRuntime("node", "./src/node-inference.js", {
      createOllamaNodeHostCommands: () => [
        {
          command: "ollama.models",
          cap: "local-inference",
          handle: async () => JSON.stringify({ provider: "ollama", models: [] }),
        },
      ],
      createOllamaNodeInferenceTool: () => ({ execute: async () => ({ content: [] }) }),
    });
    mockRuntime("setup", "./src/setup.runtime.js", {
      promptAndConfigureOllama: async () => ({ config: {} }),
    });
    mockRuntime("stream", "./src/stream.runtime.js", {
      createConfiguredOllamaStreamFn: () => async () => ({ transport: "ollama" }),
    });
    mockRuntime("web", "./src/web-search-provider.runtime.js", {
      createOllamaWebSearchProvider: () => ({
        createTool: () => ({
          execute: async ({ query }: { query: string }) => ({ query, results: [] }),
        }),
      }),
    });
    mockRuntime("wsl", "./src/wsl2-crash-loop-check.js", {
      checkWsl2CrashLoopRisk: async () => {},
    });

    const { default: ollamaPlugin } = await import("./index.js");
    const api = createTestPluginApi({ id: "ollama", runtime: createPluginRuntimeMock() });
    const memory = vi.spyOn(api, "registerEmbeddingProvider");
    const media = vi.spyOn(api, "registerMediaUnderstandingProvider");
    const commands = vi.spyOn(api, "registerNodeHostCommand");
    const tools = vi.spyOn(api, "registerTool");
    const providers = vi.spyOn(api, "registerProvider");
    const web = vi.spyOn(api, "registerWebSearchProvider");
    ollamaPlugin.register(api);
    await vi.waitFor(() => expect(isWSL2Sync).toHaveBeenCalledOnce());
    const tool = tools.mock.calls[0]?.[0];
    if (!tool || typeof tool === "function" || "contextVersion" in tool) {
      throw new Error("Expected the registered node inference tool");
    }

    expect(imports).toEqual({ memory: 0, node: 0, setup: 0, stream: 0, web: 0, wsl: 0 });
    expect(media.mock.calls[0]?.[0]).toMatchObject({ id: "ollama", capabilities: ["image"] });

    await expect(memory.mock.calls[0]?.[0].create({} as never)).resolves.toEqual({
      provider: null,
    });
    await expect(commands.mock.calls[0]?.[0].handle()).resolves.toBe(
      JSON.stringify({ provider: "ollama", models: [] }),
    );
    await expect(tool.execute("call-1", {}, undefined)).resolves.toEqual({ content: [] });
    await expect(
      web.mock.calls[0]?.[0].createTool({ config: {} } as never)?.execute({ query: "openclaw" }),
    ).resolves.toEqual({ query: "openclaw", results: [] });

    const provider = providers.mock.calls.find(([entry]) => entry.id === "ollama")?.[0];
    await expect(
      provider?.auth[0]?.run({ config: {}, prompter: {} } as never),
    ).resolves.toMatchObject({ configPatch: {} });
    const streamFn = provider?.createStreamFn?.({
      config: {},
      model: { api: "ollama", id: "qwen3:32b", provider: "ollama" },
      provider: "ollama",
    } as never);
    await expect(streamFn?.({} as never, {} as never, {})).resolves.toEqual({
      transport: "ollama",
    });

    expect(imports).toEqual({ memory: 1, node: 1, setup: 1, stream: 1, web: 1, wsl: 0 });
  });
});
