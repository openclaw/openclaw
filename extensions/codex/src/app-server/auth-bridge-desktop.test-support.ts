import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { expect, it as baseIt, vi, type Mock } from "vitest";
import { reconcileCodexComputerUseStartArtifacts as reconcileArtifacts } from "./auth-bridge.js";
import type { CodexAppServerStartOptions } from "./config.js";
import { resolveMacOSDesktopCodexAppPathCandidates } from "./desktop-app-paths.js";
import { resolveCodexManagedRuntimeAppPath } from "./managed-runtime-installation.js";

/** Uses the auth suite's canonical mock reset and private-home fixture. */
export function registerAuthBridgeDesktopTests({
  desktop,
  it,
  createStartOptions,
}: {
  desktop: {
    cache: Mock;
    marketplace: Mock;
    service: Mock;
    marketplaceSource: Mock;
    serviceSource: Mock;
  };
  it: (name: string, run: (context: { agentDir: string }) => Promise<void>) => void;
  createStartOptions: (
    overrides?: Partial<CodexAppServerStartOptions>,
  ) => CodexAppServerStartOptions;
}) {
  baseIt.each(["marketplace", "service"] as const)(
    "rejects a desktop candidate whose exact %s is unavailable",
    async (missingArtifact) => {
      await withTempDir("openclaw-codex-", async (agentDir) => {
        if (missingArtifact === "marketplace") {
          desktop.marketplaceSource.mockResolvedValueOnce(undefined);
        } else {
          desktop.serviceSource.mockResolvedValueOnce(undefined);
        }

        await expect(
          reconcileArtifacts({
            startOptions: createStartOptions({
              command: "/Applications/ChatGPT.app/Contents/Resources/codex",
            }),
            agentDir,
            pluginConfig: { computerUse: { enabled: true, autoInstall: true } },
          }),
        ).rejects.toMatchObject({
          code: "CODEX_COMPUTER_USE_CANDIDATE_ARTIFACTS_UNAVAILABLE",
        });
        expect(desktop.service).not.toHaveBeenCalled();
        expect(desktop.marketplace).not.toHaveBeenCalled();
      });
    },
  );

  baseIt.each([
    "Contents/Resources/codex",
    "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
  ])("keeps artifacts bound to the retained %s command", async (relativeCommand) => {
    await withTempDir("openclaw-codex-retained-artifacts-", async (home) => {
      const homedir = vi.spyOn(os, "homedir").mockReturnValue(home);
      try {
        const app = resolveCodexManagedRuntimeAppPath({
          version: 1,
          appName: "ChatGPT.app",
          generation: "retained",
        });
        const command = path.join(app, relativeCommand);
        await fs.mkdir(path.dirname(command), { recursive: true, mode: 0o700 });
        await fs.writeFile(command, "retained executable fixture", { mode: 0o700 });
        desktop.marketplace.mockResolvedValueOnce(
          path.join(app, "Contents/Resources/plugins/openai-bundled"),
        );
        await reconcileArtifacts({
          startOptions: createStartOptions({ command }),
          agentDir: path.join(home, "agent"),
          pluginConfig: { computerUse: { enabled: true, autoInstall: true } },
        });
        expect(desktop.service).toHaveBeenCalledWith(
          expect.objectContaining({
            appServerCommand: command,
            sourceAppCandidates: expect.arrayContaining([
              path.join(
                app,
                "Contents/Resources/cua_node/lib/node_modules/@oai/sky/Codex Computer Use.app",
              ),
            ]),
          }),
        );
        expect(desktop.marketplace).toHaveBeenCalledWith(
          expect.objectContaining({ appServerCommand: command }),
        );
      } finally {
        homedir.mockRestore();
      }
    });
  });

  baseIt.each([
    { marketplaceSource: "file:///tmp/custom-marketplace" },
    { marketplacePath: "/tmp/custom-marketplace/marketplace.json" },
    { marketplaceName: "custom-marketplace" },
  ])("keeps an exact desktop candidate with configured marketplace selection", async (selector) => {
    await withTempDir("openclaw-codex-computer-use-custom-source-", async (agentDir) => {
      await expect(
        reconcileArtifacts({
          startOptions: createStartOptions({
            command: "/Applications/ChatGPT.app/Contents/Resources/codex",
          }),
          agentDir,
          pluginConfig: {
            computerUse: { enabled: true, autoInstall: true, ...selector },
          },
        }),
      ).resolves.toBeUndefined();
      expect(desktop.marketplace).not.toHaveBeenCalled();
      expect(desktop.service).toHaveBeenCalledOnce();
    });
  });

  it("keeps package fallback artifacts on one complete desktop owner", async ({ agentDir }) => {
    const candidates = resolveMacOSDesktopCodexAppPathCandidates("darwin");
    const codexCandidate = candidates.find((candidate) => candidate.appName === "Codex.app");
    if (!codexCandidate) {
      throw new Error("expected Codex.app candidate");
    }
    desktop.serviceSource.mockImplementation(
      async (params: { sourceAppCandidates?: readonly string[] }) => {
        const source = params.sourceAppCandidates?.[0];
        return source?.includes("ChatGPT.app") ? undefined : source;
      },
    );
    desktop.marketplace.mockResolvedValueOnce("/managed/openai-bundled");

    await reconcileArtifacts({
      startOptions: createStartOptions({ command: "/cache/openclaw/codex" }),
      agentDir,
      pluginConfig: { computerUse: { enabled: true, autoInstall: true } },
    });

    expect(desktop.marketplace).toHaveBeenCalledWith(
      expect.objectContaining({
        candidates: [codexCandidate],
        appServerCommand: codexCandidate.appServerCommandPath,
      }),
    );
    expect(desktop.service).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceAppCandidates: codexCandidate.computerUseServiceAppPaths,
        appServerCommand: codexCandidate.appServerCommandPath,
      }),
    );
    expect(desktop.cache).toHaveBeenCalledWith(
      expect.objectContaining({
        bundledMarketplacePath: "/managed/openai-bundled",
      }),
    );
  });

  it("classifies native client provisioning failures as harness preflight", async ({
    agentDir,
  }) => {
    desktop.marketplace.mockResolvedValueOnce("/managed/openai-bundled");
    desktop.service.mockRejectedValueOnce(new Error("copy failed"));

    await expect(
      reconcileArtifacts({
        startOptions: createStartOptions(),
        agentDir,
        pluginConfig: { computerUse: { enabled: true, autoInstall: true } },
      }),
    ).rejects.toMatchObject({ name: "AgentHarnessPreflightError", scope: "harness" });
  });

  it("refreshes shared cache once per selected desktop source generation", async ({ agentDir }) => {
    desktop.cache.mockResolvedValue(true);
    const startOptions = createStartOptions({
      command: "/Applications/ChatGPT.app/Contents/Resources/codex",
    });
    const pluginConfig = {
      computerUse: {
        enabled: true,
        autoInstall: false,
        pluginCacheMode: "shared" as const,
      },
    };

    await reconcileArtifacts({
      startOptions,
      agentDir,
      pluginConfig,
      desktopGeneration: { epoch: 1, fingerprint: "desktop-x" },
    });
    await reconcileArtifacts({
      startOptions,
      agentDir,
      pluginConfig,
      desktopGeneration: { epoch: 1, fingerprint: "desktop-x" },
    });
    await reconcileArtifacts({
      startOptions,
      agentDir,
      pluginConfig,
      desktopGeneration: { epoch: 2, fingerprint: "desktop-y" },
    });

    expect(desktop.cache.mock.calls.map(([params]) => params.forceRefresh)).toEqual([
      true,
      false,
      true,
    ]);
    expect(desktop.service).not.toHaveBeenCalled();
    expect(desktop.marketplace).not.toHaveBeenCalled();
  });

  it("does not let a stale desktop generation publish artifacts after its successor", async ({
    agentDir,
  }) => {
    const firstMarketplaceStarted = createDeferred<void>();
    const releaseFirstMarketplace = createDeferred<void>();
    let activeMarketplaceCalls = 0;
    let maxActiveMarketplaceCalls = 0;
    desktop.marketplace
      .mockImplementationOnce(async () => {
        activeMarketplaceCalls += 1;
        maxActiveMarketplaceCalls = Math.max(maxActiveMarketplaceCalls, activeMarketplaceCalls);
        firstMarketplaceStarted.resolve();
        try {
          await releaseFirstMarketplace.promise;
          return "/managed/openai-bundled";
        } finally {
          activeMarketplaceCalls -= 1;
        }
      })
      .mockImplementationOnce(async () => {
        activeMarketplaceCalls += 1;
        maxActiveMarketplaceCalls = Math.max(maxActiveMarketplaceCalls, activeMarketplaceCalls);
        activeMarketplaceCalls -= 1;
        return "/managed/openai-bundled";
      });
    let currentEpoch = 1;
    const startOptions = createStartOptions();
    const first = reconcileArtifacts({
      startOptions,
      agentDir,
      pluginConfig: { computerUse: { enabled: true, autoInstall: true } },
      desktopGeneration: { epoch: 1, fingerprint: "desktop-x" },
      assertCurrent: () => {
        if (currentEpoch !== 1) {
          throw new Error("desktop generation X is stale");
        }
      },
    });
    const firstOutcome = first.then(
      () => undefined,
      (error: unknown) => error,
    );
    let second: Promise<void> | undefined;
    try {
      await firstMarketplaceStarted.promise;
      currentEpoch = 2;
      second = reconcileArtifacts({
        startOptions,
        agentDir,
        pluginConfig: { computerUse: { enabled: true, autoInstall: true } },
        desktopGeneration: { epoch: 2, fingerprint: "desktop-y" },
        assertCurrent: () => {
          if (currentEpoch !== 2) {
            throw new Error("desktop generation Y is stale");
          }
        },
      });
    } finally {
      releaseFirstMarketplace.resolve();
      await Promise.allSettled([firstOutcome, ...(second ? [second] : [])]);
    }
    expect(await firstOutcome).toMatchObject({ message: "desktop generation X is stale" });
    await expect(second).resolves.toBeUndefined();
    expect(maxActiveMarketplaceCalls).toBe(1);
    expect(desktop.service).toHaveBeenCalledTimes(1);
  });
}
