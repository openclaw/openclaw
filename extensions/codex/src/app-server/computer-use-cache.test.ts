import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureCodexComputerUseSharedPluginCache } from "./computer-use-cache.js";
import { resolveCodexComputerUseConfig } from "./config.js";
import { useAutoCleanupTempDirTracker } from "./test-support.js";

describe("Codex Computer Use shared plugin cache", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const config = resolveCodexComputerUseConfig({
    env: {},
    overrides: { enabled: true, autoInstall: true, pluginCacheMode: "shared" },
  });

  function fixture() {
    const root = tempDirs.make("openclaw-computer-use-cache-");
    const codexHome = path.join(root, "agent", "codex-home");
    const reconcile = (
      options: Partial<Parameters<typeof ensureCodexComputerUseSharedPluginCache>[0]>,
    ) =>
      ensureCodexComputerUseSharedPluginCache({
        codexHome,
        config,
        ...options,
      });
    return { root, codexHome, reconcile };
  }

  it("selects the first installed desktop marketplace", async () => {
    const { root, codexHome, reconcile } = fixture();
    const marketplacePath = (app: string) =>
      path.join(root, "Applications", app, "Contents", "Resources", "plugins", "openai-bundled");
    const chatGptMarketplacePath = marketplacePath("ChatGPT.app");
    const legacyCodexMarketplacePath = marketplacePath("Codex.app");
    await writeBundledComputerUsePlugin(chatGptMarketplacePath, "2.0.0");
    await writeBundledComputerUsePlugin(legacyCodexMarketplacePath, "1.0.0");

    expect(
      await reconcile({
        bundledMarketplacePathCandidates: [chatGptMarketplacePath, legacyCodexMarketplacePath],
      }),
    ).toBe(true);
    expect(
      await fs.readdir(path.join(codexHome, "plugins", "cache", "openai-bundled", "computer-use")),
    ).toEqual(["2.0.0"]);
  });

  it("copies a bundled plugin symlink without replacing current copies or removing live versions", async () => {
    const { root, codexHome, reconcile } = fixture();
    const bundledMarketplacePath = path.join(root, "Codex.app", "plugins", "openai-bundled");
    const bundledPluginRoot = path.join(bundledMarketplacePath, "plugins", "computer-use");
    await writeBundledComputerUsePlugin(bundledMarketplacePath, "1.0.857");
    const physicalPluginRoot = path.join(bundledMarketplacePath, "plugins", "source");
    await fs.rename(bundledPluginRoot, physicalPluginRoot);
    await fs.symlink(physicalPluginRoot, bundledPluginRoot, "dir");
    const externalPath = path.join(root, "external");
    await fs.mkdir(externalPath);
    await fs.writeFile(path.join(externalPath, "sentinel"), "outside");
    await fs.symlink(externalPath, path.join(bundledPluginRoot, "external-link"), "dir");
    const activeCachePath = computerUseCachePath(codexHome, "1.0.857");
    const priorCachePath = computerUseCachePath(codexHome, "1.0.799");
    await fs.mkdir(priorCachePath, { recursive: true });
    await fs.writeFile(path.join(priorCachePath, "live-client-marker"), "in use");
    await fs.symlink(bundledPluginRoot, activeCachePath, "dir");

    expect(await reconcile({ bundledMarketplacePath })).toBe(true);
    await expect(
      fs.readFile(path.join(priorCachePath, "live-client-marker"), "utf8"),
    ).resolves.toBe("in use");
    const cacheBefore = await fs.lstat(activeCachePath);
    expect(cacheBefore.isDirectory()).toBe(true);
    expect(cacheBefore.isSymbolicLink()).toBe(false);
    await expect(
      fs.readFile(path.join(activeCachePath, ".codex-plugin", "plugin.json"), "utf8"),
    ).resolves.toBe(JSON.stringify({ name: "computer-use", version: "1.0.857" }));
    // Resolving the source root must not recursively follow links outside the bundle.
    expect((await fs.lstat(path.join(activeCachePath, "external-link"))).isSymbolicLink()).toBe(
      true,
    );
    await reconcile({ bundledMarketplacePath });
    expect(await fs.lstat(activeCachePath)).toMatchObject({
      ino: cacheBefore.ino,
      mtimeMs: cacheBefore.mtimeMs,
    });
    await fs.access(priorCachePath);
  });

  it.runIf(process.platform !== "win32")(
    "rejects a symlinked managed cache parent without touching its external target",
    async () => {
      const { root, codexHome, reconcile } = fixture();
      const agentDir = path.join(root, "agent");
      const bundledMarketplacePath = path.join(root, "bundled-marketplace");
      const external = path.join(root, "external-cache");
      await writeBundledComputerUsePlugin(bundledMarketplacePath, "2.0.0");
      await fs.mkdir(codexHome, { recursive: true });
      await fs.mkdir(external, { recursive: true });
      await fs.writeFile(path.join(external, "sentinel"), "outside");
      await fs.symlink(external, path.join(codexHome, "plugins"), "dir");

      await expect(
        reconcile({
          ownershipRoot: agentDir,
          bundledMarketplacePath,
        }),
      ).rejects.toThrow(/symlink|real directories/u);
      await expect(fs.readFile(path.join(external, "sentinel"), "utf8")).resolves.toBe("outside");
      await expect(fs.access(path.join(external, "cache"))).rejects.toThrow();
    },
  );

  it("preserves the default namespace when marketplacePath is explicit", async () => {
    const { root, codexHome, reconcile } = fixture();
    const cacheRoot = path.join(codexHome, "plugins", "cache", "openai-bundled", "computer-use");
    await fs.mkdir(path.join(cacheRoot, "1.0.101"), { recursive: true });
    await fs.mkdir(path.join(cacheRoot, "1.0.102"), { recursive: true });

    expect(
      await reconcile({
        bundledMarketplacePath: path.join(root, "missing-bundled-marketplace"),
        config: {
          ...config,
          marketplacePath: path.join(
            root,
            "custom-marketplace",
            ".agents/plugins/marketplace.json",
          ),
        },
      }),
    ).toBe(false);
    await fs.access(path.join(cacheRoot, "1.0.101"));
    await fs.access(path.join(cacheRoot, "1.0.102"));
  });
});

function computerUseCachePath(codexHome: string, version: string): string {
  return path.join(codexHome, "plugins", "cache", "openai-bundled", "computer-use", version);
}

async function writeBundledComputerUsePlugin(
  bundledMarketplacePath: string,
  version: string,
): Promise<void> {
  const manifest = path.join(
    bundledMarketplacePath,
    "plugins/computer-use/.codex-plugin/plugin.json",
  );
  await fs.mkdir(path.dirname(manifest), { recursive: true });
  await fs.writeFile(manifest, JSON.stringify({ name: "computer-use", version }));
}
