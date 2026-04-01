import type { OpenClawPluginApi, PluginLogger } from "openclaw/plugin-sdk/executorch";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  loadNativeExecuTorchAddon: vi.fn(() => ({})),
  registerExecuTorchCli: vi.fn(),
}));

vi.mock("node:os", () => ({
  default: {
    platform: () => "darwin",
    arch: () => "arm64",
  },
}));

vi.mock("./src/native-addon.js", () => ({
  loadNativeExecuTorchAddon: mockState.loadNativeExecuTorchAddon,
}));

vi.mock("./src/cli.js", () => ({
  registerExecuTorchCli: mockState.registerExecuTorchCli,
}));

vi.mock("./src/provider.js", () => ({
  createExecuTorchProvider: () => ({
    id: "executorch",
    capabilities: ["audio"],
    transcribeAudio: vi.fn(async () => ({ text: "ok", model: "parakeet-tdt-0.6b-v3" })),
  }),
}));

vi.mock("./src/runner-manager.js", () => ({
  RunnerManager: class {
    state = "unloaded";
    isAlive = false;
    stop() {}
  },
}));

vi.mock("./src/runtime-config.js", () => ({
  resolveExecuTorchRuntimeConfig: () => ({
    warnings: [],
    modelPlugin: {
      id: "parakeet",
      modelId: "parakeet-tdt-0.6b-v3",
      displayName: "Parakeet-TDT",
      modelFileCandidates: ["model.pte"],
      tokenizerFileCandidates: ["tokenizer.model"],
    },
    modelRoot: "/tmp/models",
    modelDir: "/tmp/models/parakeet",
    backend: "metal",
    runtimeLibraryPath: "/tmp/libparakeet_tdt_runtime.dylib",
    modelPath: "/tmp/models/parakeet/model.pte",
    tokenizerPath: "/tmp/models/parakeet/tokenizer.model",
    dataPath: undefined,
  }),
}));

function createLogger(): PluginLogger & {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
} {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("executorch plugin gateway_start hook", () => {
  beforeEach(() => {
    vi.resetModules();
    mockState.loadNativeExecuTorchAddon.mockClear();
    mockState.registerExecuTorchCli.mockClear();
  });

  it("preloads the native addon without relying on CommonJS require", async () => {
    const { default: plugin } = await import("./index.js");
    const logger = createLogger();
    let gatewayStartHook:
      | ((event: { port: number }, ctx: { port?: number }) => void | Promise<void>)
      | undefined;

    const api = {
      id: "executorch",
      name: "ExecuTorch",
      source: "test",
      config: {},
      pluginConfig: {},
      runtime: {} as OpenClawPluginApi["runtime"],
      logger,
      registerTool() {},
      registerHook(event, handler) {
        if ((Array.isArray(event) ? event : [event]).includes("gateway_start")) {
          gatewayStartHook = handler as unknown as typeof gatewayStartHook;
        }
      },
      registerHttpRoute() {},
      registerChannel() {},
      registerGatewayMethod() {},
      registerCli() {},
      registerService() {},
      registerProvider() {},
      registerMediaProvider() {},
      registerCommand() {},
      registerContextEngine() {},
      resolvePath(input: string) {
        return input;
      },
      on() {},
    } satisfies Partial<OpenClawPluginApi>;

    plugin.register(api as unknown as OpenClawPluginApi);
    expect(gatewayStartHook).toBeTypeOf("function");

    await gatewayStartHook?.({ port: 18789 }, { port: 18789 });

    expect(mockState.loadNativeExecuTorchAddon).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith("[executorch] Native addon loaded successfully");
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("Native addon not available"),
    );
  });
});
