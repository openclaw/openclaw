import fs from "node:fs/promises";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveImplicitLocalGgufProvider,
  discoverLocalGgufModels,
} from "./local-gguf-provider.js";

describe("local-gguf-provider", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("should resolve provider with file:// baseUrl", async () => {
    vi.spyOn(fs, "readdir").mockResolvedValue([
      { name: "model-a.gguf", isFile: () => true, isDirectory: () => false },
      { name: "model-b.gguf", isFile: () => true, isDirectory: () => false },
    ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);

    const config = {
      models: {
        providers: {
          "local-gguf": {
            baseUrl: "file:///home/user/models",
          },
        },
      },
    } as unknown as OpenClawConfig;

    const provider = await resolveImplicitLocalGgufProvider({ config });
    expect(provider).not.toBeNull();
    expect(provider?.baseUrl).toBe("file:///home/user/models");
    expect(provider?.models).toHaveLength(2);
    expect(provider?.models[0].id).toBe("model-a.gguf");
    expect(provider?.models[0].name).toBe("model-a");
  });

  it("should use MODEL_PATH env var", async () => {
    vi.spyOn(fs, "readdir").mockResolvedValue([
      { name: "test.gguf", isFile: () => true, isDirectory: () => false },
    ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);

    const config = { models: {} } as unknown as OpenClawConfig;
    const env = { MODEL_PATH: "/tmp/models" } as NodeJS.ProcessEnv;

    const provider = await resolveImplicitLocalGgufProvider({ config, env });
    expect(provider).not.toBeNull();
    expect(provider?.baseUrl).toBe("file:///tmp/models");
  });

  it("should return null when no config or env", async () => {
    const config = { models: {} } as unknown as OpenClawConfig;
    const provider = await resolveImplicitLocalGgufProvider({ config });
    expect(provider).toBeNull();
  });

  it("should return null when folder is empty", async () => {
    vi.spyOn(fs, "readdir").mockResolvedValue(
      [] as unknown as Awaited<ReturnType<typeof fs.readdir>>,
    );

    const config = {
      models: {
        providers: {
          "local-gguf": {
            baseUrl: "file:///empty/folder",
          },
        },
      },
    } as unknown as OpenClawConfig;

    const provider = await resolveImplicitLocalGgufProvider({ config });
    expect(provider).toBeNull();
  });

  it("should detect reasoning models by name", async () => {
    vi.spyOn(fs, "readdir").mockResolvedValue([
      { name: "deepseek-r1-distill.gguf", isFile: () => true, isDirectory: () => false },
      { name: "llama-3.1-8b.gguf", isFile: () => true, isDirectory: () => false },
    ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);

    const config = {
      models: {
        providers: {
          "local-gguf": {
            baseUrl: "file:///home/user/models",
          },
        },
      },
    } as unknown as OpenClawConfig;

    const provider = await resolveImplicitLocalGgufProvider({ config });
    expect(provider?.models[0].reasoning).toBe(true);
    expect(provider?.models[1].reasoning).toBe(false);
  });

  it("should set zero cost for local models", async () => {
    vi.spyOn(fs, "readdir").mockResolvedValue([
      { name: "model.gguf", isFile: () => true, isDirectory: () => false },
    ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);

    const config = {
      models: {
        providers: {
          "local-gguf": {
            baseUrl: "file:///home/user/models",
          },
        },
      },
    } as unknown as OpenClawConfig;

    const provider = await resolveImplicitLocalGgufProvider({ config });
    expect(provider?.models[0].cost).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });
});

describe("discoverLocalGgufModels", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("should handle ENOENT gracefully", async () => {
    vi.spyOn(fs, "readdir").mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );

    const models = await discoverLocalGgufModels("/nonexistent");
    expect(models).toEqual([]);
  });

  it("should filter non-gguf files", async () => {
    vi.spyOn(fs, "readdir").mockResolvedValue([
      { name: "model.gguf", isFile: () => true, isDirectory: () => false },
      { name: "readme.txt", isFile: () => true, isDirectory: () => false },
      { name: "config.json", isFile: () => true, isDirectory: () => false },
    ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);

    const models = await discoverLocalGgufModels("/models");
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe("model.gguf");
  });
});
