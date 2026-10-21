import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureCodexComputerUseServiceApp } from "./computer-use-service.js";
import { resolveMacOSDesktopCodexComputerUseServiceAppCandidates } from "./desktop-app-paths.js";
import { useAutoCleanupTempDirTracker } from "./test-support.js";

const CLIENT_RELATIVE_PATH =
  "Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient";
const IDENTITY_FILE = ".test-signed-identity.json";

type EnsureParams = Parameters<typeof ensureCodexComputerUseServiceApp>[0];
type InspectServiceApp = NonNullable<EnsureParams["inspectServiceApp"]>;
type ServiceIdentity = NonNullable<Awaited<ReturnType<InspectServiceApp>>>;

const CURRENT_IDENTITY = serviceIdentity("26.817.1000761", "1000761", "current");
const STALE_IDENTITY = serviceIdentity("26.721.1000502", "1000502", "stale");
const UNEXPECTED_IDENTITY = serviceIdentity("26.900.1000900", "1000900", "unexpected");

describe("Codex Computer Use native service", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  async function setupService(owned = false) {
    const root = tempDirs.make("openclaw-computer-use-service-");
    const sourcePath = serviceAppPath(path.join(root, "source"));
    const ownershipRoot = path.join(root, "agent");
    const codexHome = path.join(owned ? ownershipRoot : root, "codex-home");
    const targetParent = path.join(codexHome, "computer-use");
    const targetPath = serviceAppPath(targetParent);
    await writeServiceFixture(sourcePath, CURRENT_IDENTITY);
    const install = (overrides: Partial<EnsureParams> = {}) =>
      ensureCodexComputerUseServiceApp({
        codexHome,
        platform: "darwin",
        sourceAppCandidates: [sourcePath],
        copyServiceApp: copyServiceFixture,
        inspectServiceApp: inspectServiceFixture,
        ...overrides,
      });
    return { root, ownershipRoot, sourcePath, codexHome, targetParent, targetPath, install };
  }

  it
    .runIf(process.platform !== "win32")
    .each(["ownershipRoot", "codexHome", "targetParent", "targetPath"] as const)(
    "rejects a symlinked %s without touching its external target",
    async (boundary) => {
      const fixture = await setupService(true);
      const { root, ownershipRoot, targetParent, install } = fixture;
      const linkedPath = fixture[boundary];
      const targetLink = boundary === "targetPath";
      const externalRoot = path.join(root, "external");
      const externalParent = targetLink
        ? externalRoot
        : path.join(externalRoot, path.relative(linkedPath, targetParent));
      const externalTarget = serviceAppPath(externalParent);
      const sentinelPath = path.join(externalParent, "sentinel.txt");
      await writeServiceFixture(externalTarget, STALE_IDENTITY);
      await fs.writeFile(sentinelPath, "outside");
      await fs.mkdir(path.dirname(linkedPath), { recursive: true });
      await fs.symlink(targetLink ? externalTarget : externalRoot, linkedPath);
      const externalInode = (await fs.lstat(externalTarget)).ino;
      const copyServiceApp = vi.fn(copyServiceFixture);

      await expect(
        install({
          ...(boundary === "ownershipRoot" ? { ownershipRoot } : {}),
          copyServiceApp,
        }),
      ).rejects.toThrow(
        targetLink
          ? /must not be a symbolic link/iu
          : /symlinked directory|real directory|symbolic link/iu,
      );

      expect(copyServiceApp).not.toHaveBeenCalled();
      expect((await fs.lstat(linkedPath)).isSymbolicLink()).toBe(true);
      if (targetLink) {
        await expect(fs.readlink(linkedPath)).resolves.toBe(externalTarget);
      }
      expect((await fs.lstat(externalTarget)).ino).toBe(externalInode);
      await expect(inspectServiceFixture(externalTarget)).resolves.toEqual(STALE_IDENTITY);
      await expect(fs.readFile(sentinelPath, "utf8")).resolves.toBe("outside");
      await expect(findInstallDebris(externalParent)).resolves.toEqual([]);
    },
  );

  it.runIf(process.platform !== "win32")(
    "refuses to publish or clean up through a parent rebound during staging",
    async () => {
      const { root, codexHome, targetParent, targetPath, install } = await setupService();
      const parkedParent = path.join(codexHome, "computer-use-owned");
      const externalParent = path.join(root, "external-computer-use");
      const externalTarget = serviceAppPath(externalParent);
      const externalSentinel = path.join(externalParent, "sentinel.txt");

      await writeServiceFixture(targetPath, STALE_IDENTITY);
      await writeServiceFixture(externalTarget, UNEXPECTED_IDENTITY);
      await fs.writeFile(externalSentinel, "outside");
      const externalInode = (await fs.lstat(externalTarget)).ino;
      let externalStagingSentinel = "";

      await expect(
        install({
          copyServiceApp: async (source, stagedTarget) => {
            await copyServiceFixture(source, stagedTarget);
            const stagingName = path.basename(path.dirname(stagedTarget));
            externalStagingSentinel = path.join(
              externalParent,
              stagingName,
              "external-sentinel.txt",
            );
            await fs.mkdir(path.dirname(externalStagingSentinel), { recursive: true });
            await fs.writeFile(externalStagingSentinel, "do-not-delete");
            await fs.rename(targetParent, parkedParent);
            await fs.symlink(externalParent, targetParent);
          },
        }),
      ).rejects.toThrow(/service parent changed during refresh/iu);

      expect(externalStagingSentinel).not.toBe("");
      await expect(fs.readFile(externalStagingSentinel, "utf8")).resolves.toBe("do-not-delete");
      await expect(fs.readFile(externalSentinel, "utf8")).resolves.toBe("outside");
      expect((await fs.lstat(externalTarget)).ino).toBe(externalInode);
      await expect(inspectServiceFixture(externalTarget)).resolves.toEqual(UNEXPECTED_IDENTITY);
      await expect(inspectServiceFixture(serviceAppPath(parkedParent))).resolves.toEqual(
        STALE_IDENTITY,
      );
      await expect(
        findInstallDebris(externalParent).then((entries) =>
          entries.filter((entry) => entry.startsWith(".service-app.backup-")),
        ),
      ).resolves.toEqual([]);
    },
  );

  it("refreshes when the signed desktop service changes at the same source path", async () => {
    const { sourcePath, targetPath, install } = await setupService();
    const copyServiceApp = vi.fn(copyServiceFixture);
    const options = { copyServiceApp };
    await install(options);
    await expect(inspectServiceFixture(targetPath)).resolves.toEqual(CURRENT_IDENTITY);
    await writeServiceFixture(sourcePath, UNEXPECTED_IDENTITY);

    await install(options);
    expect(copyServiceApp).toHaveBeenCalledTimes(2);
    await expect(inspectServiceFixture(targetPath)).resolves.toEqual(UNEXPECTED_IDENTITY);
    await expect(findInstallDebris(path.dirname(targetPath))).resolves.toEqual([]);
  });

  it("revalidates the current source after a different selection fails", async () => {
    const { root, targetPath, install } = await setupService();
    const failingSourcePath = serviceAppPath(path.join(root, "failing"));
    await writeServiceFixture(failingSourcePath, UNEXPECTED_IDENTITY);
    const inspectServiceApp = vi.fn(inspectServiceFixture);

    await install({ inspectServiceApp });
    await expect(
      install({
        sourceAppCandidates: [failingSourcePath],
        copyServiceApp: async (source, target) => {
          await copyServiceFixture(source, target);
          await writeFixtureIdentity(target, STALE_IDENTITY);
        },
        inspectServiceApp,
      }),
    ).rejects.toThrow("does not match its selected signed source");
    const inspectionsAfterFailure = inspectServiceApp.mock.calls.length;
    await expect(inspectServiceFixture(targetPath)).resolves.toEqual(CURRENT_IDENTITY);
    await expect(findInstallDebris(path.dirname(targetPath))).resolves.toEqual([]);

    await install({ inspectServiceApp });
    expect(inspectServiceApp.mock.calls.length).toBeGreaterThan(inspectionsAfterFailure);
  });

  it("reports a missing or untrusted source without changing the target", async () => {
    const { root, targetPath, install } = await setupService();
    const sourcePath = serviceAppPath(path.join(root, "untrusted"));
    await writeExecutableClient(sourcePath);
    await writeServiceFixture(targetPath, STALE_IDENTITY);

    const result = await install({
      sourceAppCandidates: [path.join(root, "missing.app"), sourcePath],
    });

    expect(result).toBe("source_missing");
    await expect(inspectServiceFixture(targetPath)).resolves.toEqual(STALE_IDENTITY);
  });

  it("coalesces parallel installations for the same managed home", async () => {
    const { targetPath, install } = await setupService();
    const copyStarted = createDeferred<void>();
    const releaseCopy = createDeferred<void>();
    const copyServiceApp = vi.fn(async (source: string, target: string) => {
      copyStarted.resolve();
      await releaseCopy.promise;
      await copyServiceFixture(source, target);
    });
    const first = install({ copyServiceApp });
    await copyStarted.promise;
    const second = install({ copyServiceApp });
    releaseCopy.resolve();
    await Promise.all([first, second]);
    expect(copyServiceApp).toHaveBeenCalledOnce();
    await expect(inspectServiceFixture(targetPath)).resolves.toEqual(CURRENT_IDENTITY);
  });

  it("restores the prior service when authorization is revoked before publication", async () => {
    const { root, targetPath, install } = await setupService();
    const secondSourcePath = serviceAppPath(path.join(root, "second"));
    await writeServiceFixture(secondSourcePath, UNEXPECTED_IDENTITY);
    await install();

    let currentnessChecks = 0;
    await expect(
      install({
        sourceAppCandidates: [secondSourcePath],
        assertCurrent: () => {
          currentnessChecks += 1;
          if (currentnessChecks === 2) {
            throw new Error("installation authorization revoked");
          }
        },
      }),
    ).rejects.toThrow("installation authorization revoked");
    expect(currentnessChecks).toBe(2);

    await expect(inspectServiceFixture(targetPath)).resolves.toEqual(CURRENT_IDENTITY);
    await expect(findInstallDebris(path.dirname(targetPath))).resolves.toEqual([]);
  });

  it("does not provision the macOS service on other platforms", async () => {
    const inspectServiceApp = vi.fn();
    await ensureCodexComputerUseServiceApp({
      codexHome: "/tmp/codex-home",
      platform: "linux",
      inspectServiceApp,
    });

    expect(inspectServiceApp).not.toHaveBeenCalled();
  });

  it("prefers service assets owned by the selected desktop app-server", () => {
    expect(
      resolveMacOSDesktopCodexComputerUseServiceAppCandidates(
        "darwin",
        "/Applications/Codex.app/Contents/Resources/codex",
      )[0],
    ).toBe(
      "/Applications/Codex.app/Contents/Resources/plugins/openai-bundled/plugins/computer-use/Codex Computer Use.app",
    );
  });
});

function serviceAppPath(parent: string) {
  return path.join(parent, "Codex Computer Use.app");
}

function serviceIdentity(version: string, build: string, label: string): ServiceIdentity {
  return {
    bundleId: "com.openai.sky.CUAService",
    teamId: "2DC432GLL2",
    clientBundleId: "com.openai.sky.CUAService.cli",
    clientTeamId: "2DC432GLL2",
    version,
    build,
    cdHash: `${label}-service`,
    clientCdHash: `${label}-client`,
  };
}

async function writeServiceFixture(appPath: string, identity: ServiceIdentity): Promise<void> {
  await writeExecutableClient(appPath);
  await fs.writeFile(path.join(appPath, "Contents", "Info.plist"), "fixture");
  await writeFixtureIdentity(appPath, identity);
}

async function writeFixtureIdentity(appPath: string, identity: ServiceIdentity): Promise<void> {
  await fs.writeFile(path.join(appPath, IDENTITY_FILE), JSON.stringify(identity));
}

async function inspectServiceFixture(appPath: string): Promise<ServiceIdentity | undefined> {
  try {
    return JSON.parse(
      await fs.readFile(path.join(appPath, IDENTITY_FILE), "utf8"),
    ) as ServiceIdentity;
  } catch {
    return undefined;
  }
}

async function copyServiceFixture(sourcePath: string, targetPath: string): Promise<void> {
  await fs.cp(sourcePath, targetPath, { recursive: true });
}

async function writeExecutableClient(appPath: string): Promise<void> {
  const clientPath = path.join(appPath, CLIENT_RELATIVE_PATH);
  await fs.mkdir(path.dirname(clientPath), { recursive: true });
  await fs.writeFile(clientPath, "client");
  await fs.chmod(clientPath, 0o755);
}

async function findInstallDebris(targetParent: string): Promise<string[]> {
  return (await fs.readdir(targetParent)).filter(
    (entry) =>
      entry.startsWith(".service-app.staging-") || entry.startsWith(".service-app.backup-"),
  );
}
