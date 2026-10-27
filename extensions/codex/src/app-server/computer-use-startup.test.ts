import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as processRuntime from "openclaw/plugin-sdk/process-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerClient } from "./client.js";
import { ensureCodexComputerUseSharedPluginCache } from "./computer-use-cache.js";
import { ensureCodexManagedBundledMarketplace } from "./computer-use-marketplace.js";
import { ensureCodexComputerUseServiceApp } from "./computer-use-service.js";
import * as service from "./computer-use-service.js";
import {
  writeBundledComputerUsePlugin,
  writeMarketplaceCandidate,
} from "./computer-use.test-support.js";
import { resolveCodexComputerUseConfig } from "./config.js";
import { resolveMacOSDesktopCodexComputerUseServiceAppCandidates } from "./desktop-app-paths.js";
import * as desktopPaths from "./desktop-app-paths.js";
import * as generation from "./desktop-generation.js";
import { isJsonObject } from "./protocol.js";
import {
  clearSharedCodexAppServerClientAndWait,
  createIsolatedCodexAppServerClient,
} from "./shared-client.js";
import { createClientHarness, useAutoCleanupTempDirTracker } from "./test-support.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => void mockServiceCopy());
afterEach(() => vi.restoreAllMocks());
const ensureService = service.ensureCodexComputerUseServiceApp;
const resolveServiceSource = service.resolveCodexComputerUseServiceAppSourcePath;

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
      const copyServiceApp = mockServiceCopy();

      await expect(install(boundary === "ownershipRoot" ? { ownershipRoot } : {})).rejects.toThrow(
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

      mockServiceCopy(async (source, stagedTarget) => {
        await copyServiceFixture(source, stagedTarget);
        const stagingName = path.basename(path.dirname(stagedTarget));
        externalStagingSentinel = path.join(externalParent, stagingName, "external-sentinel.txt");
        await fs.mkdir(path.dirname(externalStagingSentinel), { recursive: true });
        await fs.writeFile(externalStagingSentinel, "do-not-delete");
        await fs.rename(targetParent, parkedParent);
        await fs.symlink(externalParent, targetParent);
      });
      await expect(install()).rejects.toThrow(/service parent changed during refresh/iu);

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
    await install();
    await expect(inspectServiceFixture(targetPath)).resolves.toEqual(CURRENT_IDENTITY);
    await writeServiceFixture(sourcePath, UNEXPECTED_IDENTITY);

    await install();
    await expect(inspectServiceFixture(targetPath)).resolves.toEqual(UNEXPECTED_IDENTITY);
    await expect(findInstallDebris(path.dirname(targetPath))).resolves.toEqual([]);
  });

  it("revalidates the current source after a different selection fails", async () => {
    const { root, targetPath, install } = await setupService();
    const failingSourcePath = serviceAppPath(path.join(root, "failing"));
    await writeServiceFixture(failingSourcePath, UNEXPECTED_IDENTITY);
    const inspectServiceApp = vi.fn(inspectServiceFixture);

    await install({ inspectServiceApp });
    mockServiceCopy(async (source, target) => {
      await copyServiceFixture(source, target);
      await writeFixtureIdentity(target, STALE_IDENTITY);
    });
    await expect(
      install({
        sourceAppCandidates: [failingSourcePath],
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
    const copyServiceApp = mockServiceCopy(async (source: string, target: string) => {
      copyStarted.resolve();
      await releaseCopy.promise;
      await copyServiceFixture(source, target);
    });
    const first = install();
    await copyStarted.promise;
    const second = install();
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

function mockServiceCopy(copy = copyServiceFixture) {
  return vi.spyOn(processRuntime, "runExec").mockImplementation(async (command, args, options) => {
    expect(command).toBe("/usr/bin/ditto");
    expect(args[0]).toBe("--noqtn");
    expect(options).toEqual({ logOutput: false, timeoutMs: 120_000 });
    await copy(args[1]!, args[2]!);
    return { stdout: "", stderr: "" };
  });
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

type CacheInput = Parameters<typeof ensureCodexComputerUseSharedPluginCache>[0];
const cacheConfig = resolveCodexComputerUseConfig({
  env: {},
  overrides: { enabled: true, pluginCacheMode: "shared" },
});

function cacheFixture() {
  const root = tempDirs.make("openclaw-computer-use-cache-");
  const codexHome = path.join(root, "agent", "codex-home");
  const reconcile = (options: Partial<CacheInput>) =>
    ensureCodexComputerUseSharedPluginCache({ codexHome, config: cacheConfig, ...options });
  return { root, codexHome, reconcile };
}

it("selects the first installed desktop marketplace", async () => {
  const { root, codexHome, reconcile } = cacheFixture();
  const marketplacePath = (app: string) =>
    path.join(root, "Applications", app, "Contents", "Resources", "plugins", "openai-bundled");
  const chatGptMarketplacePath = marketplacePath("ChatGPT.app");
  const legacyCodexMarketplacePath = marketplacePath("Codex.app");
  await writeBundledComputerUsePlugin(chatGptMarketplacePath, "2.0.0");
  await writeBundledComputerUsePlugin(legacyCodexMarketplacePath, "1.0.0");

  const resolveMarketplace =
    desktopPaths.resolveFirstExistingMacOSDesktopCodexBundledMarketplacePath;
  vi.spyOn(
    desktopPaths,
    "resolveFirstExistingMacOSDesktopCodexBundledMarketplacePath",
  ).mockImplementation(() =>
    resolveMarketplace({ candidates: [chatGptMarketplacePath, legacyCodexMarketplacePath] }),
  );
  expect(await reconcile({})).toBe(true);
  expect(await fs.readdir(computerUseCachePath(codexHome))).toEqual(["2.0.0"]);
});

it("copies a bundled plugin symlink without replacing current copies or removing live versions", async () => {
  const { root, codexHome, reconcile } = cacheFixture();
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
  await expect(fs.readFile(path.join(priorCachePath, "live-client-marker"), "utf8")).resolves.toBe(
    "in use",
  );
  const cacheBefore = await fs.lstat(activeCachePath);
  expect(cacheBefore.isDirectory()).toBe(true);
  expect(cacheBefore.isSymbolicLink()).toBe(false);
  await expect(
    fs.readFile(path.join(activeCachePath, ".codex-plugin", "plugin.json"), "utf8"),
  ).resolves.toBe(JSON.stringify({ name: "computer-use", version: "1.0.857" }));
  // Resolving the source root must not recursively follow links outside the bundle.
  const externalLink = await fs.lstat(path.join(activeCachePath, "external-link"));
  expect(externalLink.isSymbolicLink()).toBe(true);
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
    const { root, codexHome, reconcile } = cacheFixture();
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
  const { root, codexHome, reconcile } = cacheFixture();
  const cacheRoot = computerUseCachePath(codexHome);
  const bundledMarketplacePath = path.join(root, "bundled-marketplace");
  await writeBundledComputerUsePlugin(bundledMarketplacePath, "2.0.0");
  await fs.mkdir(path.join(cacheRoot, "1.0.101"), { recursive: true });
  await fs.mkdir(path.join(cacheRoot, "1.0.102"), { recursive: true });

  expect(
    await reconcile({
      bundledMarketplacePath,
      config: { ...cacheConfig, marketplacePath: "custom-marketplace.json" },
    }),
  ).toBe(false);
  await fs.access(path.join(cacheRoot, "1.0.101"));
  await fs.access(path.join(cacheRoot, "1.0.102"));
});

function computerUseCachePath(codexHome: string, version = ""): string {
  return path.join(codexHome, "plugins", "cache", "openai-bundled", "computer-use", version);
}

describe("managed Codex bundled marketplace", () => {
  async function fixture() {
    const root = tempDirs.make("openclaw-codex-marketplace-");
    const candidate = await writeMarketplaceCandidate(root);
    const agentDir = path.join(root, "agent");
    const codexHome = path.join(agentDir, "codex-home");
    const target = path.join(codexHome, ".tmp", "bundled-marketplaces", "openai-bundled");
    const publish = (appServerCommand?: string) =>
      ensureCodexManagedBundledMarketplace({
        codexHome,
        ownershipRoot: agentDir,
        candidates: [candidate],
        appServerCommand,
      });
    return { root, candidate, target, publish };
  }

  it("coalesces concurrent publication without leaving swap debris", async () => {
    const { candidate, target, publish } = await fixture();
    const results = await Promise.all(Array.from({ length: 3 }, () => publish()));
    expect(results).toEqual([target, target, target]);
    expect((await fs.lstat(target)).isDirectory()).toBe(true);
    expect(await fs.realpath(target)).toBe(target);
    expect(await fs.readlink(path.join(target, "plugins"))).toBe(
      path.join(candidate.bundledMarketplacePath, "plugins"),
    );
    expect(
      (await fs.readdir(path.dirname(target))).filter((entry) =>
        entry.startsWith(".openai-bundled"),
      ),
    ).toEqual([]);
    await expect(publish()).resolves.toBe(target);
  });

  it("does not replace an unowned directory at the reserved managed path", async () => {
    const { target, publish } = await fixture();
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, "sentinel"), "operator-owned");

    await expect(publish()).rejects.toThrow("unowned bundled marketplace");
    await expect(fs.readFile(path.join(target, "sentinel"), "utf8")).resolves.toBe(
      "operator-owned",
    );
  });

  it.runIf(process.platform !== "win32")(
    "does not publish through a marketplace parent rebound during the staged swap",
    async () => {
      const { root, target, publish } = await fixture();
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

      await expect(publish()).rejects.toThrow();
      await expect(fs.readFile(path.join(external, "sentinel"), "utf8")).resolves.toBe("outside");
      await expect(fs.access(path.join(external, "openai-bundled"))).rejects.toThrow();
    },
  );
});

describe("createIsolatedCodexAppServerClient artifact refresh", () => {
  afterEach(async () => {
    await clearSharedCodexAppServerClientAndWait();
    vi.restoreAllMocks();
  });

  it.each(["service", "cache"])("refreshes the managed %s before startup", async (artifact) => {
    const inspection = { platform: "darwin" as const, inspectServiceApp: inspectServiceFixture };
    const root = tempDirs.make("openclaw-computer-use-startup-");
    const agentDir = path.join(root, "agent");
    const codexHome = path.join(agentDir, "codex-home");
    const candidate = await writeMarketplaceCandidate(root, "1.0.857", "plugins/openai-bundled");
    const {
      appBundlePath,
      appServerCommandPath: command,
      bundledMarketplacePath: marketplace,
    } = candidate;
    const sourceService = path.join(appBundlePath, "Codex Computer Use.app");
    const targetService = path.join(codexHome, "computer-use", "Codex Computer Use.app");
    const pluginRoot = path.join(marketplace, "plugins", "computer-use");
    const cachePath = path.join(codexHome, "plugins/cache/openai-bundled/computer-use/1.0.857");
    await writeServiceFixture(sourceService, CURRENT_IDENTITY);
    await writeServiceFixture(
      targetService,
      artifact === "service" ? STALE_IDENTITY : CURRENT_IDENTITY,
    );
    await fs.writeFile(path.join(pluginRoot, "generation.txt"), "new-cache");
    await fs.cp(pluginRoot, cachePath, { recursive: true });
    await fs.writeFile(
      path.join(cachePath, "generation.txt"),
      artifact === "cache" ? "old-cache" : "new-cache",
    );

    vi.spyOn(desktopPaths, "resolveMacOSDesktopCodexAppPathCandidates").mockReturnValue([
      { ...candidate, computerUseServiceAppPaths: [sourceService] },
    ]);
    vi.spyOn(service, "resolveCodexComputerUseServiceAppSourcePath").mockImplementation((params) =>
      resolveServiceSource({ ...params, ...inspection }),
    );
    vi.spyOn(service, "ensureCodexComputerUseServiceApp").mockImplementation((params) =>
      ensureService({
        ...params,
        ...inspection,
      }),
    );

    vi.spyOn(generation, "waitForCodexDesktopGeneration").mockResolvedValue({
      epoch: 1,
      fingerprint: "desktop-original",
    });

    const harness = createClientHarness({
      onWrite(line, send) {
        const request: unknown = JSON.parse(line);
        if (isJsonObject(request) && request.id !== undefined && request.method === "initialize") {
          send({
            id: request.id,
            result: { userAgent: `codex-cli/${CODEX_APP_SERVER_VERSION}` },
          });
        }
      },
    });
    vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
    try {
      const startup = createIsolatedCodexAppServerClient({
        agentDir,
        authProfileId: null,
        startOptions: {
          transport: "stdio",
          homeScope: "agent",
          commandSource: "resolved-managed",
          command,
          args: ["app-server"],
          headers: {},
        },
        pluginConfig: {
          computerUse: { enabled: true, autoInstall: true, pluginCacheMode: "shared" },
        },
      });
      await expect(startup).resolves.toBe(harness.client);
      await expect(inspectServiceFixture(targetService)).resolves.toEqual(CURRENT_IDENTITY);
      await expect(fs.readFile(path.join(cachePath, "generation.txt"), "utf8")).resolves.toBe(
        "new-cache",
      );
      expect(await fs.readdir(path.dirname(targetService))).toEqual(["Codex Computer Use.app"]);
      expect(await fs.readdir(path.dirname(cachePath))).toEqual(["1.0.857"]);
    } finally {
      await harness.client.closeAndWait();
    }
  });
});
