import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chromeProductRoots, installStableChromeExtension } from "./extension-install-layout.js";
import { installRegistration } from "./extension-install-registration.js";
import {
  installChromeExtensionBootstrap,
  repairChromeExtensionNativeHosts,
} from "./extension-install.js";
import {
  predictedId,
  useExtensionInstallFixture,
  writeChromePreferences,
} from "./extension-install.test-support.js";

const fixture = useExtensionInstallFixture();

afterEach(() => {
  vi.restoreAllMocks();
});

describe("native host repair", () => {
  it("refuses a config selection changed while the replacement manifest is being staged", async () => {
    const value = await fixture();
    const root = chromeProductRoots(value.deps)[0]!;
    const installed = await installStableChromeExtension(value.bundledDir, value.deps);
    const extensionIds = [await predictedId(installed), await predictedId(value.bundledDir)];
    const params = { root, extensionIds, pluginRoot: value.pluginRoot, deps: value.deps };
    const original = await installRegistration({ ...params, browserProfile: "work" });
    const manifestBefore = await fs.readFile(original.manifestPath, "utf8");
    const launcherBefore = await fs.readFile(original.launcherPath!, "utf8");
    const replacement = await installRegistration({
      ...params,
      browserProfile: "work",
      deps: {
        ...value.deps,
        env: { ...value.deps.env, OPENCLAW_CONFIG_PATH: path.join(value.root, "other.json") },
      },
    });
    const replacementManifest = await fs.readFile(replacement.manifestPath, "utf8");
    await fs.writeFile(original.launcherPath!, launcherBefore, { mode: 0o700 });
    await fs.writeFile(original.manifestPath, manifestBefore, { mode: 0o600 });
    const open = fs.open.bind(fs);
    let changed = false;
    vi.spyOn(fs, "open").mockImplementation(async (file, ...args) => {
      const handle = await open(file, ...args);
      if (
        !changed &&
        typeof file === "string" &&
        path.dirname(file) === root.nativeManifestDir &&
        file !== original.manifestPath
      ) {
        changed = true;
        await fs.writeFile(original.manifestPath, replacementManifest, { mode: 0o600 });
      }
      return handle;
    });
    await expect(
      installRegistration({
        ...params,
        browserProfile: "other",
        requireCurrentLaunchContext: true,
      }),
    ).rejects.toThrow("OPENCLAW_CONFIG_PATH");
    expect(changed).toBe(true);
    expect(await fs.readFile(original.manifestPath, "utf8")).toBe(replacementManifest);
    expect(await fs.readFile(replacement.launcherPath!, "utf8")).toContain("other.json");
  });

  it.each([
    { installedConfig: "custom config's $& path.json", callerConfig: undefined },
    { installedConfig: "custom config's $& path.json", callerConfig: "different.json" },
    { installedConfig: undefined, callerConfig: "different.json" },
  ])(
    "preserves registered configuration when repairing with $callerConfig",
    async ({ installedConfig, callerConfig }) => {
      const value = await fixture();
      const deps = {
        ...value.deps,
        env: {
          ...value.deps.env,
          OPENCLAW_CONFIG_PATH: installedConfig
            ? path.join(value.root, installedConfig)
            : undefined,
        },
      };
      const installed = await installStableChromeExtension(value.bundledDir, deps);
      const chrome = chromeProductRoots(deps)[0]!;
      await writeChromePreferences({
        userDataDir: chrome.userDataDir,
        profile: "Default",
        entries: { [await predictedId(installed)]: { location: 4, path: installed } },
      });
      const initial = await installChromeExtensionBootstrap({
        ...value,
        deps,
        browserProfile: "work",
      });
      expect(initial.issues).toEqual([]);
      const manifestPath = initial.registrations[0]!.manifestPath;
      const oldManifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as { path: string };
      const exportedContext = (content: string) =>
        content.split("\n").filter((line) => line.startsWith("export OPENCLAW_"));
      const before = exportedContext(await fs.readFile(oldManifest.path, "utf8"));
      const nativeHostPath = path.join(value.root, "replacement-entry.js");
      await fs.writeFile(nativeHostPath, "export {};\n", { mode: 0o600 });
      const repaired = await repairChromeExtensionNativeHosts({
        ...value,
        fromNativeHostPath: value.nativeHostPath,
        deps: {
          ...deps,
          nativeHostPath,
          env: {
            ...value.deps.env,
            OPENCLAW_CONFIG_PATH: callerConfig ? path.join(value.root, callerConfig) : undefined,
          },
        },
      });
      expect(repaired.warnings).toEqual([]);
      expect(repaired.changes).toHaveLength(1);
      const current = JSON.parse(await fs.readFile(manifestPath, "utf8")) as { path: string };
      expect(exportedContext(await fs.readFile(current.path, "utf8"))).toEqual(before);
      expect(repaired.registrations[0]).toMatchObject({ browserProfile: "work" });
    },
  );

  it("preserves literal replacement metacharacters in the installation path", async () => {
    const value = await fixture();
    const deps = { ...value.deps, stateDir: path.join(value.homeDir, "claw $& state's dir") };
    const installed = await installStableChromeExtension(value.bundledDir, deps);
    const chrome = chromeProductRoots(deps)[0]!;
    await writeChromePreferences({
      userDataDir: chrome.userDataDir,
      profile: "Default",
      entries: { [await predictedId(installed)]: { location: 4, path: installed } },
    });
    const installedStatus = await installChromeExtensionBootstrap({ ...value, deps });
    expect(installedStatus.issues).toEqual([]);
    expect(installedStatus.manualSetupRequired).toBe(false);
    const observed = await repairChromeExtensionNativeHosts({ ...value, deps, dryRun: true });
    expect(observed.retentionSafe).toBe(true);
    expect(observed.retainedNativeHostPaths).toEqual([value.nativeHostPath]);
  });

  it("refreshes a retired package target without reading profiles or replacing another installation", async () => {
    const value = await fixture("darwin");
    const installed = await installStableChromeExtension(value.bundledDir, value.deps);
    const extensionId = await predictedId(installed, value.deps.platform);
    const roots = chromeProductRoots(value.deps).filter(
      (root) => root.product !== "chrome-for-testing",
    );
    for (const root of roots) {
      await writeChromePreferences({
        userDataDir: root.userDataDir,
        profile: "Default",
        entries: { [extensionId]: { location: 4, path: installed } },
      });
    }
    const original = await installChromeExtensionBootstrap({ ...value, deps: value.deps });
    const chromium = original.registrations.find((entry) => entry.product === "chromium")!;
    const appEntry = path.join(value.root, "app-native-host.js");
    await fs.writeFile(appEntry, "export {};\n", { mode: 0o600 });
    await installRegistration({
      root: roots[1]!,
      extensionIds: [extensionId, await predictedId(value.bundledDir, value.deps.platform)],
      pluginRoot: value.pluginRoot,
      deps: { ...value.deps, nativeHostPath: appEntry },
    });
    const manifest = JSON.parse(await fs.readFile(chromium.manifestPath, "utf8")) as {
      path: string;
    };
    const appLauncher = await fs.readFile(manifest.path, "utf8");
    const relocated = path.join(value.root, "new-package");
    await fs.rename(path.join(value.root, "package"), relocated);
    const repairParams = {
      bundledDir: path.join(relocated, "extensions/browser/chrome-extension"),
      pluginRoot: path.join(relocated, "extensions/browser"),
      fromNativeHostPath: value.nativeHostPath,
      deps: { ...value.deps, nativeHostPath: path.join(relocated, "native-host-entry.js") },
    };
    const readFile = fs.readFile.bind(fs);
    const readSpy = vi
      .spyOn(fs, "readFile")
      .mockImplementation((...args: Parameters<typeof fs.readFile>) => {
        if (typeof args[0] === "string" && args[0].endsWith("Preferences")) {
          throw new Error("personal profile access is denied");
        }
        return readFile(...args);
      });
    const before = await repairChromeExtensionNativeHosts({ ...repairParams, dryRun: true });
    expect(before.retentionSafe).toBe(true);
    expect(before.retainedNativeHostPaths).toEqual([appEntry, value.nativeHostPath].toSorted());
    expect(before.changes).toEqual([]);
    const repaired = await repairChromeExtensionNativeHosts(repairParams);
    expect(repaired.warnings).toEqual([]);
    expect(repaired.changes).toHaveLength(1);
    expect(repaired.retentionSafe).toBe(true);
    expect(repaired.retainedNativeHostPaths).toEqual(
      [appEntry, repairParams.deps.nativeHostPath].toSorted(),
    );
    expect(await fs.readFile(manifest.path, "utf8")).toBe(appLauncher);
    expect(
      (
        await repairChromeExtensionNativeHosts({
          ...repairParams,
          fromNativeHostPath: repairParams.deps.nativeHostPath,
        })
      ).changes,
    ).toEqual([]);
    expect(
      readSpy.mock.calls.some(([file]) => typeof file === "string" && file.endsWith("Preferences")),
    ).toBe(false);
  });

  it("keeps the old registration usable when publishing the replacement manifest fails", async () => {
    const value = await fixture();
    const installed = await installStableChromeExtension(value.bundledDir, value.deps);
    const chrome = chromeProductRoots(value.deps)[0]!;
    await writeChromePreferences({
      userDataDir: chrome.userDataDir,
      profile: "Default",
      entries: { [await predictedId(installed)]: { location: 4, path: installed } },
    });
    const original = await installChromeExtensionBootstrap({ ...value, deps: value.deps });
    const manifestPath = original.registrations[0]!.manifestPath;
    const before = await fs.readFile(manifestPath, "utf8");
    const oldManifest = JSON.parse(before) as { path: string };
    const oldLauncher = await fs.readFile(oldManifest.path, "utf8");
    const newPackage = path.join(value.root, "next-package");
    await fs.cp(path.join(value.root, "package"), newPackage, { recursive: true });
    const params = {
      bundledDir: path.join(newPackage, "extensions/browser/chrome-extension"),
      pluginRoot: path.join(newPackage, "extensions/browser"),
      fromNativeHostPath: value.nativeHostPath,
      deps: { ...value.deps, nativeHostPath: path.join(newPackage, "native-host-entry.js") },
    };
    const rename = fs.rename.bind(fs);
    const publish = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (to === manifestPath) {
        throw Object.assign(new Error("synthetic manifest publication failure"), { code: "EIO" });
      }
      return await rename(from, to);
    });
    const failed = await repairChromeExtensionNativeHosts(params);
    expect(failed.warnings.join("\n")).toContain("synthetic manifest publication failure");
    expect(await fs.readFile(manifestPath, "utf8")).toBe(before);
    expect(await fs.readFile(oldManifest.path, "utf8")).toBe(oldLauncher);
    expect(failed.retentionSafe).toBe(true);
    expect(failed.retainedNativeHostPaths).toContain(value.nativeHostPath);
    publish.mockRestore();
    const repaired = await repairChromeExtensionNativeHosts(params);
    expect(repaired.warnings).toEqual([]);
    expect(repaired.changes).toHaveLength(1);
    expect(repaired.retainedNativeHostPaths).toEqual([params.deps.nativeHostPath]);
  });

  it("refuses unscoped repair and reports malformed registration targets as unsafe for retention", async () => {
    const value = await fixture();
    await expect(repairChromeExtensionNativeHosts(value)).rejects.toThrow("requires --from");
    const root = chromeProductRoots(value.deps)[0]!;
    await fs.mkdir(root.nativeManifestDir, { recursive: true, mode: 0o700 });
    const manifestPath = path.join(root.nativeManifestDir, "ai.openclaw.browser_bootstrap.json");
    await fs.writeFile(manifestPath, "{}\n", { mode: 0o600 });
    const observed = await repairChromeExtensionNativeHosts({ ...value, dryRun: true });
    expect(observed.retentionSafe).toBe(false);
    expect(observed.retainedNativeHostPaths).toEqual([]);
    expect(observed.warnings).toHaveLength(1);
    expect(await fs.readFile(manifestPath, "utf8")).toBe("{}\n");
  });
});
