// Tests for stable Homebrew execPath resolution in embeddings-worker.ts.
import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetStableWorkerExecPathCache,
  resolveStableWorkerExecPath,
} from "./embeddings-worker.js";

describe("resolveStableWorkerExecPath", () => {
  beforeEach(() => {
    // Clear module-scoped cache so each test gets a fresh resolution.
    __resetStableWorkerExecPathCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns original path for non-Cellar execPath (/usr/bin/node)", async () => {
    // Set a deterministic non-Cellar path so the test is not dependent on
    // the test runner's actual process.execPath (which may be a Homebrew
    // Cellar path on macOS runners).
    const execPath = "/usr/bin/node";

    const origExecPath = process.execPath;
    Object.defineProperty(process, "execPath", {
      value: execPath,
      configurable: true,
      writable: true,
    });

    try {
      const result = await resolveStableWorkerExecPath();
      expect(result).toBe(execPath);
    } finally {
      Object.defineProperty(process, "execPath", {
        value: origExecPath,
        configurable: true,
        writable: true,
      });
    }
  });

  it("resolves to opt symlink when Homebrew Cellar path is detected and opt path exists", async () => {
    const execPath = "/opt/homebrew/Cellar/node/26.3.0/bin/node";
    const expectedOptPath = "/opt/homebrew/opt/node/bin/node";

    // Mock fs.access — opt path exists
    const accessMock = vi.spyOn(fs, "access");
    accessMock.mockImplementation(async (inputPath: unknown) => {
      if (inputPath === expectedOptPath) {
        return;
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    // Override process.execPath
    const origExecPath = process.execPath;
    Object.defineProperty(process, "execPath", {
      value: execPath,
      configurable: true,
      writable: true,
    });

    try {
      const result = await resolveStableWorkerExecPath();
      expect(result).toBe(expectedOptPath);
      expect(accessMock).toHaveBeenCalledWith(expectedOptPath);
    } finally {
      Object.defineProperty(process, "execPath", {
        value: origExecPath,
        configurable: true,
        writable: true,
      });
    }
  });

  it("falls back to bin symlink when opt path is absent (default node formula)", async () => {
    const execPath = "/opt/homebrew/Cellar/node/26.3.0/bin/node";
    const optPath = "/opt/homebrew/opt/node/bin/node";
    const expectedBinPath = "/opt/homebrew/bin/node";

    const accessMock = vi.spyOn(fs, "access");
    accessMock.mockImplementation(async (inputPath: unknown) => {
      if (inputPath === expectedBinPath) {
        return;
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    const origExecPath = process.execPath;
    Object.defineProperty(process, "execPath", {
      value: execPath,
      configurable: true,
      writable: true,
    });

    try {
      const result = await resolveStableWorkerExecPath();
      expect(result).toBe(expectedBinPath);
      expect(accessMock).toHaveBeenCalledWith(optPath);
      expect(accessMock).toHaveBeenCalledWith(expectedBinPath);
    } finally {
      Object.defineProperty(process, "execPath", {
        value: origExecPath,
        configurable: true,
        writable: true,
      });
    }
  });

  it("returns original execPath when neither opt nor bin symlinks exist", async () => {
    const execPath = "/opt/homebrew/Cellar/node/26.3.0/bin/node";

    const accessMock = vi.spyOn(fs, "access");
    accessMock.mockImplementation(async () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    const origExecPath = process.execPath;
    Object.defineProperty(process, "execPath", {
      value: execPath,
      configurable: true,
      writable: true,
    });

    try {
      const result = await resolveStableWorkerExecPath();
      expect(result).toBe(execPath);
    } finally {
      Object.defineProperty(process, "execPath", {
        value: origExecPath,
        configurable: true,
        writable: true,
      });
    }
  });

  it("resolves versioned formula node@22 via opt symlink", async () => {
    const execPath = "/usr/local/Cellar/node@22/22.11.0/bin/node";
    const expectedOptPath = "/usr/local/opt/node@22/bin/node";

    const accessMock = vi.spyOn(fs, "access");
    accessMock.mockImplementation(async (inputPath: unknown) => {
      if (inputPath === expectedOptPath) {
        return;
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    const origExecPath = process.execPath;
    Object.defineProperty(process, "execPath", {
      value: execPath,
      configurable: true,
      writable: true,
    });

    try {
      const result = await resolveStableWorkerExecPath();
      expect(result).toBe(expectedOptPath);
      expect(accessMock).toHaveBeenCalledWith(expectedOptPath);
    } finally {
      Object.defineProperty(process, "execPath", {
        value: origExecPath,
        configurable: true,
        writable: true,
      });
    }
  });

  it("skips bin fallback for versioned formula (node@22 has no plain bin symlink)", async () => {
    const execPath = "/usr/local/Cellar/node@22/22.11.0/bin/node";
    const optPath = "/usr/local/opt/node@22/bin/node";

    const accessMock = vi.spyOn(fs, "access");
    // Neither opt nor bin exists
    accessMock.mockImplementation(async () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    const origExecPath = process.execPath;
    Object.defineProperty(process, "execPath", {
      value: execPath,
      configurable: true,
      writable: true,
    });

    try {
      const result = await resolveStableWorkerExecPath();
      // For node@22, only the opt path is tried (no plain bin/node for versioned formulas)
      expect(result).toBe(execPath);
      expect(accessMock).toHaveBeenCalledTimes(1);
      expect(accessMock).toHaveBeenCalledWith(optPath);
    } finally {
      Object.defineProperty(process, "execPath", {
        value: origExecPath,
        configurable: true,
        writable: true,
      });
    }
  });

  it("caches resolved path on second call", async () => {
    const execPath = "/opt/homebrew/Cellar/node/26.3.0/bin/node";
    const expectedOptPath = "/opt/homebrew/opt/node/bin/node";

    const accessMock = vi.spyOn(fs, "access");
    accessMock.mockImplementation(async (inputPath: unknown) => {
      if (inputPath === expectedOptPath) {
        return;
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    const origExecPath = process.execPath;
    Object.defineProperty(process, "execPath", {
      value: execPath,
      configurable: true,
      writable: true,
    });

    try {
      const first = await resolveStableWorkerExecPath();
      expect(first).toBe(expectedOptPath);
      // fs.access should have been called once (for the opt path check)
      expect(accessMock).toHaveBeenCalledTimes(1);

      // Second call should use cache — fs.access shouldn't be called again
      const second = await resolveStableWorkerExecPath();
      expect(second).toBe(expectedOptPath);
      expect(accessMock).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(process, "execPath", {
        value: origExecPath,
        configurable: true,
        writable: true,
      });
    }
  });
});

describe("embeddings-worker ensureChild async", () => {
  it("does not break existing provider creation contract", async () => {
    // Just verify the module exports still match expected shape
    const mod = await import("./embeddings-worker.js");
    expect(typeof mod.createLocalEmbeddingWorkerProvider).toBe("function");
    // The function should be async (return a thenable)
    const result = mod.createLocalEmbeddingWorkerProvider({
      provider: "local",
      model: "test-model",
      config: {},
    });
    // Should be a Promise/thenable
    expect(result).toBeInstanceOf(Promise);
    // Clean up — the provider will try to fork and fail in test env
    try {
      await result;
    } catch {
      // Expected: fork will fail in test environment
    }
  });
});
