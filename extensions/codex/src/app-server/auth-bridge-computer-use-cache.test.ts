import fs from "node:fs/promises";
import path from "node:path";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { expect, it, vi } from "vitest";
import {
  reconcileCodexComputerUseStartArtifacts,
  resolveCodexAppServerHomeDir,
} from "./auth-bridge.js";
import type { CodexAppServerStartOptions } from "./config.js";
import { resolveMacOSDesktopCodexAppPathCandidates } from "./desktop-app-paths.js";

type MockDesktopCandidate = ReturnType<typeof resolveMacOSDesktopCodexAppPathCandidates>[number];
const computerUseServiceMocks = vi.hoisted(() => ({
  ensureCodexComputerUseSharedPluginCache: vi.fn<
    (_params: { forceRefresh?: boolean }) => Promise<boolean>
  >(async () => false),
  ensureCodexManagedBundledMarketplace: vi.fn<(_params?: unknown) => Promise<string | undefined>>(
    async () => undefined,
  ),
  ensureCodexComputerUseServiceApp: vi.fn<
    (_params?: unknown) => Promise<{
      status: "already_current" | "source_missing";
      changed: boolean;
    }>
  >(async () => ({ status: "already_current", changed: false })),
  resolveCodexManagedBundledMarketplaceSource: vi.fn<
    (params: {
      candidates?: readonly MockDesktopCandidate[];
    }) => Promise<MockDesktopCandidate | undefined>
  >(async (params) => params.candidates?.[0]),
  resolveCodexComputerUseServiceAppSourcePath: vi.fn<
    (params: { sourceAppCandidates?: readonly string[] }) => Promise<string | undefined>
  >(async (params) => params.sourceAppCandidates?.[0]),
}));

vi.mock("./computer-use-service.js", () => ({
  ensureCodexComputerUseServiceApp: computerUseServiceMocks.ensureCodexComputerUseServiceApp,
  resolveCodexComputerUseServiceAppSourcePath:
    computerUseServiceMocks.resolveCodexComputerUseServiceAppSourcePath,
}));

vi.mock("./computer-use-marketplace.js", () => ({
  ensureCodexManagedBundledMarketplace:
    computerUseServiceMocks.ensureCodexManagedBundledMarketplace,
  resolveCodexManagedBundledMarketplaceSource:
    computerUseServiceMocks.resolveCodexManagedBundledMarketplaceSource,
}));

vi.mock("./computer-use-cache.js", () => ({
  ensureCodexComputerUseSharedPluginCache:
    computerUseServiceMocks.ensureCodexComputerUseSharedPluginCache,
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
    computerUseServiceMocks.ensureCodexManagedBundledMarketplace.mockResolvedValueOnce(marketplace);
    await reconcileCodexComputerUseStartArtifacts({
      startOptions,
      agentDir,
      pluginConfig: {
        computerUse: { enabled: true, autoInstall: true, pluginCacheMode: "shared" },
      },
    });
    expect(computerUseServiceMocks.ensureCodexComputerUseSharedPluginCache).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          pluginName: "computer-use",
          mcpServerName: "computer-use",
        }),
      }),
    );
  });
});
