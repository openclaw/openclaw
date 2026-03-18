import fs from "node:fs/promises";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
// Don't mock the provider — mock fs instead so the real provider code runs
import { LocalGgufDiscoverySource } from "./local-gguf-discovery.js";

describe("LocalGgufDiscoverySource", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("should return empty when no config", async () => {
    const source = new LocalGgufDiscoverySource();
    const models = await source.discover({});
    expect(models).toEqual([]);
  });

  it("should return empty when no local-gguf provider configured", async () => {
    const source = new LocalGgufDiscoverySource();
    const models = await source.discover({
      config: { models: {} } as unknown as OpenClawConfig,
    });
    expect(models).toEqual([]);
  });

  it("should return discovered models from filesystem", async () => {
    vi.spyOn(fs, "readdir").mockResolvedValue([
      { name: "model-a.gguf", isFile: () => true, isDirectory: () => false },
      { name: "deepseek-r1.gguf", isFile: () => true, isDirectory: () => false },
    ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);

    const config = {
      models: {
        providers: {
          "local-gguf": {
            baseUrl: "file:///models",
          },
        },
      },
    } as unknown as OpenClawConfig;

    const source = new LocalGgufDiscoverySource();
    const models = await source.discover({ config });

    expect(models).toHaveLength(2);
    expect(models[0].id).toBe("model-a.gguf");
    expect(models[0].provider).toBe("local-gguf");
    expect(models[0].reasoning).toBe(false);
    expect(models[1].id).toBe("deepseek-r1.gguf");
    expect(models[1].reasoning).toBe(true);
  });

  it("should return empty when folder has no gguf files", async () => {
    vi.spyOn(fs, "readdir").mockResolvedValue(
      [] as unknown as Awaited<ReturnType<typeof fs.readdir>>,
    );

    const config = {
      models: {
        providers: {
          "local-gguf": {
            baseUrl: "file:///empty",
          },
        },
      },
    } as unknown as OpenClawConfig;

    const source = new LocalGgufDiscoverySource();
    const models = await source.discover({ config });
    expect(models).toEqual([]);
  });

  it("should handle fs errors gracefully", async () => {
    vi.spyOn(fs, "readdir").mockRejectedValue(new Error("permission denied"));

    const config = {
      models: {
        providers: {
          "local-gguf": {
            baseUrl: "file:///protected",
          },
        },
      },
    } as unknown as OpenClawConfig;

    const source = new LocalGgufDiscoverySource();
    const models = await source.discover({ config });
    expect(models).toEqual([]);
  });
});
