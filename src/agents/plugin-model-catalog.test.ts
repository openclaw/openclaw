import { join } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock node:fs so we can simulate transient readdirSync failures.
// The real implementation is preserved via vi.importActual so normal
// file-system operations (mkdirSync etc.) still work in helper setup.
vi.mock("node:fs", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    readdirSync: vi.fn(actual.readdirSync as (...args: unknown[]) => unknown),
  };
});

const { listPluginModelCatalogRelativePaths } = await import("./plugin-model-catalog.js");

describe("listPluginModelCatalogRelativePaths", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns sorted paths for existing plugin directories", async () => {
    const { mkdirSync, writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
    const tmpDir = mkdtempSync(join("/tmp", "plugin-test-"));
    const pluginsDir = join(tmpDir, "plugins");
    mkdirSync(pluginsDir, { recursive: true });
    mkdirSync(join(pluginsDir, "anthropic"), { recursive: true });
    mkdirSync(join(pluginsDir, "minimax"), { recursive: true });
    writeFileSync(join(pluginsDir, "anthropic", "catalog.json"), "{}");
    writeFileSync(join(pluginsDir, "minimax", "catalog.json"), "{}");

    const result = listPluginModelCatalogRelativePaths(tmpDir);

    expect(result).toHaveLength(2);
    expect(result[0]).toBe("plugins/anthropic/catalog.json");
    expect(result[1]).toBe("plugins/minimax/catalog.json");
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array when plugins dir does not exist", () => {
    const result = listPluginModelCatalogRelativePaths("/nonexistent/path");
    expect(result).toEqual([]);
  });

  it("lists catalog.json paths even when the file itself is absent", async () => {
    // listPluginModelCatalogRelativePaths only enumerates plugin directories,
    // it does not check whether catalog.json actually exists on disk.
    const { mkdirSync, mkdtempSync, rmSync } = await import("node:fs");
    const tmpDir = mkdtempSync(join("/tmp", "plugin-test-"));
    const pluginsDir = join(tmpDir, "plugins");
    mkdirSync(pluginsDir, { recursive: true });
    mkdirSync(join(pluginsDir, "empty-plugin"), { recursive: true });

    const result = listPluginModelCatalogRelativePaths(tmpDir);

    expect(result).toEqual(["plugins/empty-plugin/catalog.json"]);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("retries readdirSync once on transient error and succeeds", async () => {
    const mockDirent = (name: string) =>
      ({ name, isDirectory: () => true }) as import("node:fs").Dirent;
    const fakeEntries: any = [mockDirent("anthropic"), mockDirent("minimax")];
    // Sync requires cast because getReadDirMock is not visible in ESM surface
    const readdirMock = vi.mocked((await import("node:fs")).readdirSync);

    readdirMock
      .mockImplementationOnce(() => {
        throw new Error("FsSafeError: directory changed during operation");
      })
      .mockImplementationOnce(() => fakeEntries);

    const result = listPluginModelCatalogRelativePaths("/tmp/work");

    // Expect exactly 2 calls: first fails, second succeeds
    expect(readdirMock).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe("plugins/anthropic/catalog.json");
    expect(result[1]).toBe("plugins/minimax/catalog.json");
  });

  it("returns empty array after two consecutive readdirSync failures", async () => {
    const readdirMock = vi.mocked((await import("node:fs")).readdirSync);
    readdirMock.mockImplementation(() => {
      throw new Error("FsSafeError: directory changed during operation");
    });

    const result = listPluginModelCatalogRelativePaths("/tmp/work");

    expect(readdirMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual([]);
  });
});
