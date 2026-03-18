import { describe, it, expect, vi, beforeEach } from "vitest";
import { LocalGgufModelManager } from "./local-gguf-manager.js";

vi.mock("./pi-embedded-runner/logger.js", () => ({
  log: {
    info: vi.fn(),
    error: vi.fn(),
  },
}));

const mockDispose = vi.fn();
const mockLoadModel = vi.fn().mockImplementation((opts: { modelPath: string }) => ({
  path: opts.modelPath,
  dispose: mockDispose,
}));
const mockGetLlama = vi.fn().mockResolvedValue({
  loadModel: mockLoadModel,
});

vi.mock("node-llama-cpp", () => ({
  getLlama: mockGetLlama,
}));

describe("LocalGgufModelManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (LocalGgufModelManager as unknown as { instance: null }).instance = null;
  });

  it("should be a singleton", () => {
    const instance1 = LocalGgufModelManager.getInstance();
    const instance2 = LocalGgufModelManager.getInstance();
    expect(instance1).toBe(instance2);
  });

  it("should load a model", async () => {
    const manager = LocalGgufModelManager.getInstance();
    const model = await manager.getModel("/path/to/model-a.gguf");

    expect(mockGetLlama).toHaveBeenCalled();
    expect(mockLoadModel).toHaveBeenCalledWith({ modelPath: "/path/to/model-a.gguf" });
    expect(model).toBeDefined();
  });

  it("should cache loaded models", async () => {
    const manager = LocalGgufModelManager.getInstance();
    await manager.getModel("/path/to/model-a.gguf");
    await manager.getModel("/path/to/model-a.gguf");

    expect(mockLoadModel).toHaveBeenCalledTimes(1);
  });

  it("should explicitly unload a model", async () => {
    const manager = LocalGgufModelManager.getInstance();
    await manager.getModel("/path/to/model-x.gguf");

    await manager.unloadModel("/path/to/model-x.gguf");
    expect(mockDispose).toHaveBeenCalledTimes(1);

    await manager.getModel("/path/to/model-x.gguf");
    expect(mockLoadModel).toHaveBeenCalledTimes(2);
  });

  it("should clear cache", async () => {
    const manager = LocalGgufModelManager.getInstance();
    await manager.getModel("/path/to/model-1.gguf");
    await manager.getModel("/path/to/model-2.gguf");

    await manager.clearCache();
    expect(mockDispose).toHaveBeenCalledTimes(2);

    await manager.getModel("/path/to/model-1.gguf");
    expect(mockLoadModel).toHaveBeenCalledTimes(3);
  });

  it("should respect configured max cached models via configure", async () => {
    const manager = LocalGgufModelManager.getInstance();
    manager.configure({ maxCachedModels: 1 });

    await manager.getModel("/path/to/model-a.gguf");
    await manager.getModel("/path/to/model-b.gguf");

    expect(mockDispose).toHaveBeenCalledTimes(1);
  });
});
