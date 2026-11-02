import fs from "node:fs/promises";
import path from "node:path";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { expect, it, vi } from "vitest";
import { resolveCodexAppServerHomeDir } from "./auth-start-options.js";
import { reconcileCodexComputerUseStartArtifacts } from "./computer-use-artifacts.js";
import { ensureCodexComputerUseSharedPluginCache } from "./computer-use-cache.js";
import { ensureCodexManagedBundledMarketplace } from "./computer-use-marketplace.js";
import type { CodexAppServerStartOptions } from "./config.js";

// mock-isolation: Artifact reconciliation must not install or inspect a real desktop service.
vi.mock("./computer-use-service.js", () => ({
  ensureCodexComputerUseServiceApp: vi.fn<
    typeof import("./computer-use-service.js").ensureCodexComputerUseServiceApp
  >(async () => undefined),
  resolveCodexComputerUseServiceAppSourcePath: vi.fn<
    (params: { sourceAppCandidates?: readonly string[] }) => Promise<string | undefined>
  >(async (params) => params.sourceAppCandidates?.[0]),
}));

// mock-isolation: The fixture supplies its own marketplace instead of modifying host plugins.
vi.mock("./computer-use-marketplace.js", () => ({
  ensureCodexManagedBundledMarketplace: vi.fn<typeof ensureCodexManagedBundledMarketplace>(
    async () => undefined,
  ),
  resolveCodexManagedBundledMarketplaceSource: vi.fn<
    typeof import("./computer-use-marketplace.js").resolveCodexManagedBundledMarketplaceSource
  >(async (params) => params.candidates?.[0]),
}));

// mock-isolation: Observe cache preparation without writing the shared host cache.
vi.mock("./computer-use-cache.js", () => ({
  ensureCodexComputerUseSharedPluginCache: vi.fn(async () => false),
}));

vi.mock("./desktop-app-paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./desktop-app-paths.js")>();
  return {
    ...actual,
    resolveMacOSDesktopCodexAppPathCandidates: (platform?: NodeJS.Platform) =>
      actual.resolveMacOSDesktopCodexAppPathCandidates(platform ?? "darwin"),
  };
});

const startOptions: CodexAppServerStartOptions = {
  transport: "stdio",
  command: "codex",
  commandSource: "resolved-managed",
  args: ["app-server"],
  headers: { authorization: "Bearer ***" },
};

it("review: keeps cache identity unchanged before effective native policy is available", async () => {
  await withTempDir("openclaw-codex-policy-cache-", async (agentDir) => {
    const marketplace = path.join(agentDir, "prepared-marketplace");
    for (const name of ["computer-use", "unified-computer-use"]) {
      await fs.mkdir(path.join(marketplace, "plugins", name, ".codex-plugin"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(marketplace, "plugins", name, ".codex-plugin", "plugin.json"),
        JSON.stringify({ name }),
      );
    }
    await fs.writeFile(
      path.join(marketplace, "plugins", "unified-computer-use", ".mcp.json"),
      JSON.stringify({ mcpServers: { cua_repl: { enabled: true } } }),
    );
    const home = resolveCodexAppServerHomeDir(agentDir);
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[plugins."computer-use@openai-bundled"]\nenabled = false\n',
    );
    vi.mocked(ensureCodexManagedBundledMarketplace).mockResolvedValueOnce(marketplace);
    await reconcileCodexComputerUseStartArtifacts({
      startOptions,
      agentDir,
      desktopGeneration: { epoch: 7, fingerprint: "fixture-desktop" },
      forceCacheRefresh: true,
      pluginConfig: {
        computerUse: { enabled: true, autoInstall: true, pluginCacheMode: "shared" },
      },
    });
    expect(ensureCodexManagedBundledMarketplace).toHaveBeenCalledWith(
      expect.objectContaining({ desktopFingerprint: "fixture-desktop", forceRefresh: true }),
    );
    expect(ensureCodexComputerUseSharedPluginCache).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          pluginName: "computer-use",
          mcpServerName: "computer-use",
        }),
      }),
    );
  });
});
