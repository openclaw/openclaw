// Codex tests cover Computer Use shared plugin cache reconciliation.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureCodexComputerUseSharedPluginCache } from "./computer-use-cache.js";
import type { ResolvedCodexComputerUseConfig } from "./config.js";

describe("Codex Computer Use shared plugin cache", () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    for (const cleanupPath of cleanupPaths.splice(0)) {
      await fs.rm(cleanupPath, { recursive: true, force: true });
    }
  });

  it("symlinks agent cache entries to the local bundled plugin and removes stale versions", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-computer-use-cache-"));
    cleanupPaths.push(root);
    const bundledMarketplacePath = path.join(root, "Codex.app", "plugins", "openai-bundled");
    const bundledPluginRoot = path.join(bundledMarketplacePath, "plugins", "computer-use");
    await fs.mkdir(path.join(bundledPluginRoot, ".codex-plugin"), { recursive: true });
    await fs.writeFile(
      path.join(bundledPluginRoot, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "computer-use", version: "1.0.857" }),
    );
    const codexHome = path.join(root, "agent", "codex-home");
    await fs.mkdir(
      path.join(codexHome, "plugins", "cache", "openai-bundled", "computer-use", "1.0.799"),
      { recursive: true },
    );

    const result = await ensureCodexComputerUseSharedPluginCache({
      codexHome,
      bundledMarketplacePath,
      config: computerUseConfig(),
    });

    expect(result).toMatchObject({
      status: "linked",
      changed: true,
      version: "1.0.857",
      removedStaleVersions: ["1.0.799"],
    });
    const linkPath = path.join(
      codexHome,
      "plugins",
      "cache",
      "openai-bundled",
      "computer-use",
      "1.0.857",
    );
    expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(true);
    expect(await fs.realpath(linkPath)).toBe(await fs.realpath(bundledPluginRoot));
    await expect(
      fs.access(
        path.join(codexHome, "plugins", "cache", "openai-bundled", "computer-use", "1.0.799"),
      ),
    ).rejects.toThrow();
  });

  it("leaves cache entries alone in independent mode", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-computer-use-cache-"));
    cleanupPaths.push(root);
    const result = await ensureCodexComputerUseSharedPluginCache({
      codexHome: path.join(root, "codex-home"),
      bundledMarketplacePath: path.join(root, "missing"),
      config: computerUseConfig({ pluginCacheMode: "independent" }),
    });

    expect(result).toMatchObject({
      status: "independent",
      changed: false,
      removedStaleVersions: [],
    });
  });
});

function computerUseConfig(
  overrides: Partial<ResolvedCodexComputerUseConfig> = {},
): ResolvedCodexComputerUseConfig {
  return {
    enabled: true,
    autoInstall: true,
    marketplaceDiscoveryTimeoutMs: 60_000,
    liveTestTimeoutMs: 60_000,
    toolCallTimeoutMs: 60_000,
    leaseTimeoutMs: 300_000,
    healthCheckIntervalMinutes: 60,
    pluginCacheMode: "symlink",
    fallbackOnFailure: false,
    autoRepair: true,
    pluginName: "computer-use",
    mcpServerName: "computer-use",
    ...overrides,
  };
}
