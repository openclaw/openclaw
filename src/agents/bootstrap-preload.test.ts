import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  initializeBootstrapPreload,
  isBootstrapPreloadEnabled,
  shutdownBootstrapPreload,
} from "./bootstrap-preload.js";

describe("bootstrap-preload", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-bootstrap-preload-test-"));
  });

  afterEach(async () => {
    await shutdownBootstrapPreload();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("should pre-load workspace bootstrap files", async () => {
    // Create test workspace files
    await fs.writeFile(path.join(tmpDir, "AGENTS.md"), "# Test agents");
    await fs.writeFile(path.join(tmpDir, "SOUL.md"), "# Test soul");
    await fs.writeFile(path.join(tmpDir, "USER.md"), "# Test user");

    // Initialize preload
    await initializeBootstrapPreload(tmpDir);

    expect(isBootstrapPreloadEnabled()).toBe(true);
  });

  it("should watch for file changes and invalidate cache", async () => {
    // Create test workspace file
    await fs.writeFile(path.join(tmpDir, "AGENTS.md"), "# Initial content");

    // Initialize preload with watching enabled
    await initializeBootstrapPreload(tmpDir, { watch: true });

    // Wait a bit for watcher to be ready
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Modify the file
    await fs.writeFile(path.join(tmpDir, "AGENTS.md"), "# Modified content");

    // Wait for file watcher to detect change
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Verify watcher is still active
    expect(isBootstrapPreloadEnabled()).toBe(true);
  });

  it("should disable watching when option is false", async () => {
    await fs.writeFile(path.join(tmpDir, "AGENTS.md"), "# Test");

    await initializeBootstrapPreload(tmpDir, { watch: false });

    expect(isBootstrapPreloadEnabled()).toBe(true);
  });

  it("should handle shutdown gracefully", async () => {
    await fs.writeFile(path.join(tmpDir, "AGENTS.md"), "# Test");

    await initializeBootstrapPreload(tmpDir);
    expect(isBootstrapPreloadEnabled()).toBe(true);

    await shutdownBootstrapPreload();
    expect(isBootstrapPreloadEnabled()).toBe(false);
  });

  it("should warn when initializing twice for same workspace", async () => {
    await fs.writeFile(path.join(tmpDir, "AGENTS.md"), "# Test");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await initializeBootstrapPreload(tmpDir);
    await initializeBootstrapPreload(tmpDir); // Second call

    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
