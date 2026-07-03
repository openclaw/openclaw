// Memory Host SDK tests cover embedding worker path resolution.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NoParamCallback } from "node:fs";

// ---------------------------------------------------------------------------
// resolveHomebrewStablePath tests — accessSync-mocked
// ---------------------------------------------------------------------------

// We must mock before importing the module under test.
const mockAccessSync = vi.fn<NoParamCallback>();

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    accessSync: mockAccessSync,
  };
});

const { resolveHomebrewStablePath } = await import("./embeddings-worker.js");

describe("resolveHomebrewStablePath", () => {
  beforeEach(() => {
    mockAccessSync.mockReset();
  });

  it("returns the original path for non-Cellar paths", () => {
    const path = "/usr/local/bin/node";
    expect(resolveHomebrewStablePath(path)).toBe(path);
    expect(mockAccessSync).not.toHaveBeenCalled();
  });

  it("returns the original path for non-Node Cellar paths", () => {
    const path = "/opt/homebrew/Cellar/python/3.12/bin/python3";
    expect(resolveHomebrewStablePath(path)).toBe(path);
    expect(mockAccessSync).not.toHaveBeenCalled();
  });

  it("returns opt symlink when Cellar path and opt path exists", () => {
    const cellarPath = "/opt/homebrew/Cellar/node/25.7.0/bin/node";
    const optPath = "/opt/homebrew/opt/node/bin/node";
    mockAccessSync.mockImplementation((p: string) => {
      if (p === optPath) return;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    expect(resolveHomebrewStablePath(cellarPath)).toBe(optPath);
  });

  it("returns bin symlink for default node formula when only bin path exists", () => {
    const cellarPath = "/opt/homebrew/Cellar/node/25.7.0/bin/node";
    const binPath = "/opt/homebrew/bin/node";
    mockAccessSync.mockImplementation((p: string) => {
      if (p === binPath) return;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    expect(resolveHomebrewStablePath(cellarPath)).toBe(binPath);
  });

  it("returns original path when Cellar path and no stable symlink exists", () => {
    const cellarPath = "/opt/homebrew/Cellar/node/25.7.0/bin/node";
    mockAccessSync.mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    expect(resolveHomebrewStablePath(cellarPath)).toBe(cellarPath);
  });

  it("handles versioned formula (node@22) via opt path", () => {
    const cellarPath = "/opt/homebrew/Cellar/node@22/22.14.0/bin/node";
    const optPath = "/opt/homebrew/opt/node@22/bin/node";
    mockAccessSync.mockImplementation((p: string) => {
      if (p === optPath) return;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    expect(resolveHomebrewStablePath(cellarPath)).toBe(optPath);
  });

  it("handles Linuxbrew paths under /home/linuxbrew", () => {
    const cellarPath = "/home/linuxbrew/.linuxbrew/Cellar/node/25.7.0/bin/node";
    const optPath = "/home/linuxbrew/.linuxbrew/opt/node/bin/node";
    mockAccessSync.mockImplementation((p: string) => {
      if (p === optPath) return;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    expect(resolveHomebrewStablePath(cellarPath)).toBe(optPath);
  });

  it("prefers opt path over bin path when both exist", () => {
    const cellarPath = "/opt/homebrew/Cellar/node/25.7.0/bin/node";
    const optPath = "/opt/homebrew/opt/node/bin/node";
    const binPath = "/opt/homebrew/bin/node";
    mockAccessSync.mockImplementation((p: string) => {
      if (p === optPath || p === binPath) return;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    expect(resolveHomebrewStablePath(cellarPath)).toBe(optPath);
  });
});
