import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureCodexManagedBundledMarketplace } from "./computer-use-marketplace.js";
import type { MacOSDesktopCodexAppPathCandidate } from "./desktop-app-paths.js";
import { useAutoCleanupTempDirTracker } from "./test-support.js";

describe("managed Codex bundled marketplace", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("publishes a real reserved root with links to the selected desktop marketplace", async () => {
    const root = tempDirs.make("openclaw-codex-marketplace-");
    const candidate = await writeCandidate(root);
    const agentDir = path.join(root, "agent");
    const codexHome = path.join(agentDir, "codex-home");

    const result = await ensureCodexManagedBundledMarketplace({
      codexHome,
      ownershipRoot: agentDir,
      appServerCommand: candidate.appServerCommandPath,
      candidates: [candidate],
    });

    const target = reservedMarketplacePath(codexHome);
    expect(result).toBe(target);
    expect((await fs.lstat(target)).isDirectory()).toBe(true);
    expect(await fs.realpath(target)).toBe(target);
    expect(await fs.readlink(path.join(target, "plugins"))).toBe(
      path.join(candidate.bundledMarketplacePath, "plugins"),
    );
    await expect(
      ensureCodexManagedBundledMarketplace({
        codexHome,
        ownershipRoot: agentDir,
        candidates: [candidate],
      }),
    ).resolves.toBe(target);
  });

  it("coalesces concurrent publication without leaving swap debris", async () => {
    const root = tempDirs.make("openclaw-codex-marketplace-concurrent-");
    const candidate = await writeCandidate(root);
    const agentDir = path.join(root, "agent");
    const codexHome = path.join(agentDir, "codex-home");

    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        ensureCodexManagedBundledMarketplace({
          codexHome,
          ownershipRoot: agentDir,
          candidates: [candidate],
        }),
      ),
    );

    const target = reservedMarketplacePath(codexHome);
    expect(results).toEqual([target, target, target]);
    expect(await fs.readlink(path.join(target, "plugins"))).toBe(
      path.join(candidate.bundledMarketplacePath, "plugins"),
    );
    expect(
      (await fs.readdir(path.dirname(target))).filter((entry) =>
        entry.startsWith(".openai-bundled"),
      ),
    ).toEqual([]);
  });

  it("does not replace an unowned directory at the reserved managed path", async () => {
    const root = tempDirs.make("openclaw-codex-marketplace-unowned-");
    const candidate = await writeCandidate(root);
    const agentDir = path.join(root, "agent");
    const codexHome = path.join(agentDir, "codex-home");
    const target = reservedMarketplacePath(codexHome);
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, "sentinel"), "operator-owned");

    await expect(
      ensureCodexManagedBundledMarketplace({
        codexHome,
        ownershipRoot: agentDir,
        candidates: [candidate],
      }),
    ).rejects.toThrow("unowned bundled marketplace");
    await expect(fs.readFile(path.join(target, "sentinel"), "utf8")).resolves.toBe(
      "operator-owned",
    );
  });

  it.runIf(process.platform !== "win32")(
    "does not publish through a marketplace parent rebound during the staged swap",
    async () => {
      const root = tempDirs.make("openclaw-codex-marketplace-rebind-");
      const candidate = await writeCandidate(root);
      const agentDir = path.join(root, "agent");
      const codexHome = path.join(agentDir, "codex-home");
      const target = reservedMarketplacePath(codexHome);
      const parent = path.dirname(target);
      const movedParent = `${parent}.moved`;
      const external = path.join(root, "external");
      await fs.mkdir(external, { recursive: true });
      await fs.writeFile(path.join(external, "sentinel"), "outside");
      const rename = fs.rename.bind(fs);
      vi.spyOn(fs, "rename").mockImplementationOnce(async (source, destination) => {
        await rename(parent, movedParent);
        await fs.symlink(external, parent, "dir");
        return await rename(source, destination);
      });

      await expect(
        ensureCodexManagedBundledMarketplace({
          codexHome,
          ownershipRoot: agentDir,
          candidates: [candidate],
        }),
      ).rejects.toThrow();
      await expect(fs.readFile(path.join(external, "sentinel"), "utf8")).resolves.toBe("outside");
      await expect(fs.access(path.join(external, "openai-bundled"))).rejects.toThrow();
    },
  );
});

async function writeCandidate(root: string): Promise<MacOSDesktopCodexAppPathCandidate> {
  const appBundlePath = path.join(root, "ChatGPT.app");
  const bundledMarketplacePath = path.join(appBundlePath, "openai-bundled");
  await fs.mkdir(path.join(bundledMarketplacePath, ".agents", "plugins"), { recursive: true });
  await fs.mkdir(path.join(bundledMarketplacePath, "plugins", "computer-use", ".codex-plugin"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(bundledMarketplacePath, ".agents", "plugins", "marketplace.json"),
    JSON.stringify({ name: "openai-bundled", plugins: [{ name: "computer-use" }] }),
  );
  await fs.writeFile(
    path.join(bundledMarketplacePath, "plugins", "computer-use", ".codex-plugin", "plugin.json"),
    JSON.stringify({ name: "computer-use", version: "1.0.0" }),
  );
  return {
    appName: "ChatGPT.app",
    appBundlePath,
    appServerCommandPath: path.join(appBundlePath, "codex"),
    bundledMarketplacePath,
    computerUseServiceAppPaths: [],
  };
}

/** Codex reserves this documented location; fixtures prepare and observe that public contract. */
function reservedMarketplacePath(codexHome: string): string {
  return path.join(codexHome, ".tmp", "bundled-marketplaces", "openai-bundled");
}
