import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chromeProductRoots,
  installStableChromeExtension,
  installRegistration,
  installChromeExtensionBootstrap,
  repairChromeExtensionNativeHosts,
} from "./extension-install-fixture.test-support.js";
import {
  predictedId,
  useExtensionInstallFixture,
  writeChromePreferences,
} from "./extension-install.test-support.js";

const fixture = useExtensionInstallFixture();

type Fixture = Awaited<ReturnType<typeof fixture>>;
type RepairResult = Awaited<ReturnType<typeof repairChromeExtensionNativeHosts>>;
const read = (file: string) => fs.readFile(file, "utf8");
const exportedContext = (content: string) =>
  content.split("\n").filter((line) => line.startsWith("export OPENCLAW_"));
async function launcher(manifestPath: string) {
  const manifest = JSON.parse(await read(manifestPath)) as { path: string };
  return { path: manifest.path, content: await read(manifest.path) };
}
async function relocated(value: Fixture, move = false) {
  const target = path.join(value.root, "next-package");
  if (move) {
    await fs.rename(path.join(value.root, "package"), target);
  } else {
    await fs.cp(path.join(value.root, "package"), target, { recursive: true });
  }
  return {
    bundledDir: path.join(target, "extensions/browser/chrome-extension"),
    pluginRoot: path.join(target, "extensions/browser"),
    fromNativeHostPath: value.nativeHostPath,
    deps: { ...value.deps, nativeHostPath: path.join(target, "native-host-entry.js") },
  };
}
function expectRepaired(result: RepairResult, paths: string[]) {
  expect(result.warnings).toEqual([]);
  expect(result.changes).toHaveLength(1);
  expect(result.retentionSafe).toBe(true);
  expect(result.retainedNativeHostPaths).toEqual(paths);
}
async function prepareUnpacked(
  value: Fixture,
  deps = value.deps,
  roots = chromeProductRoots(deps).slice(0, 1),
) {
  const installed = await installStableChromeExtension(value.bundledDir, deps);
  const extensionId = await predictedId(installed, deps.platform);
  for (const root of roots) {
    await writeChromePreferences({
      userDataDir: root.userDataDir,
      profile: "Default",
      entries: { [extensionId]: { location: 4, path: installed } },
    });
  }
  return extensionId;
}

afterEach(() => {
  vi.restoreAllMocks();
});

function configDeps(value: Fixture, config?: string) {
  return {
    ...value.deps,
    env: {
      ...value.deps.env,
      OPENCLAW_CONFIG_PATH: config ? path.join(value.root, config) : undefined,
    },
  };
}

describe("native host repair", () => {
  it("refuses a config selection changed while the replacement manifest is being staged", async () => {
    const value = await fixture();
    const root = chromeProductRoots(value.deps)[0]!;
    const installed = await installStableChromeExtension(value.bundledDir, value.deps);
    const extensionIds = [await predictedId(installed), await predictedId(value.bundledDir)];
    const params = { root, extensionIds, pluginRoot: value.pluginRoot, deps: value.deps };
    const original = await installRegistration({ ...params, browserProfile: "work" });
    const manifestBefore = await read(original.manifestPath);
    const launcherBefore = await read(original.launcherPath!);
    const replacement = await installRegistration({
      ...params,
      browserProfile: "work",
      deps: configDeps(value, "other.json"),
    });
    const replacementManifest = await read(replacement.manifestPath);
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
    expect(await read(original.manifestPath)).toBe(replacementManifest);
    expect(await read(replacement.launcherPath!)).toContain("other.json");
  });

  it.each(["custom config's $& path.json", undefined])(
    "preserves registered config %s when repairing from a different config",
    async (installedConfig) => {
      const value = await fixture();
      const deps = {
        ...configDeps(value, installedConfig),
        stateDir: path.join(value.homeDir, "claw $& state's dir"),
      };
      await prepareUnpacked(value, deps);
      const initial = await installChromeExtensionBootstrap({
        ...value,
        deps,
        browserProfile: "work",
      });
      expect(initial).toMatchObject({ issues: [], manualSetupRequired: false });
      const manifestPath = initial.registrations[0]!.manifestPath;
      const before = exportedContext((await launcher(manifestPath)).content);
      const nativeHostPath = path.join(value.root, "replacement-entry.js");
      await fs.writeFile(nativeHostPath, "export {};\n", { mode: 0o600 });
      const repaired = await repairChromeExtensionNativeHosts({
        ...value,
        fromNativeHostPath: value.nativeHostPath,
        deps: {
          ...deps,
          nativeHostPath,
          env: configDeps(value, "different.json").env,
        },
      });
      expectRepaired(repaired, [nativeHostPath]);
      expect(exportedContext((await launcher(manifestPath)).content)).toEqual(before);
      expect(repaired.registrations[0]).toMatchObject({ browserProfile: "work" });
    },
  );

  it("refreshes a retired package target without reading profiles or replacing another installation", async () => {
    const value = await fixture("darwin");
    const roots = chromeProductRoots(value.deps).filter(
      (root) => root.product !== "chrome-for-testing",
    );
    const extensionId = await prepareUnpacked(value, value.deps, roots);
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
    const appLauncher = await launcher(chromium.manifestPath);
    const repairParams = await relocated(value, true);
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
    expect(before).toMatchObject({
      retentionSafe: true,
      retainedNativeHostPaths: [appEntry, value.nativeHostPath].toSorted(),
      changes: [],
    });
    const repaired = await repairChromeExtensionNativeHosts(repairParams);
    expectRepaired(repaired, [appEntry, repairParams.deps.nativeHostPath].toSorted());
    expect(await read(appLauncher.path)).toBe(appLauncher.content);
    const again = await repairChromeExtensionNativeHosts({
      ...repairParams,
      fromNativeHostPath: repairParams.deps.nativeHostPath,
    });
    expect(again.changes).toEqual([]);
    expect(
      readSpy.mock.calls.some(([file]) => typeof file === "string" && file.endsWith("Preferences")),
    ).toBe(false);
  });

  it("keeps the old registration usable when publishing the replacement manifest fails", async () => {
    const value = await fixture();
    await prepareUnpacked(value);
    const original = await installChromeExtensionBootstrap({ ...value, deps: value.deps });
    const manifestPath = original.registrations[0]!.manifestPath;
    const before = await read(manifestPath);
    const oldLauncher = await launcher(manifestPath);
    const params = await relocated(value);
    const rename = fs.rename.bind(fs);
    const publish = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (to === manifestPath) {
        throw Object.assign(new Error("synthetic manifest publication failure"), { code: "EIO" });
      }
      return await rename(from, to);
    });
    const failed = await repairChromeExtensionNativeHosts(params);
    expect(failed.warnings.join("\n")).toContain("synthetic manifest publication failure");
    expect(await read(manifestPath)).toBe(before);
    expect(await read(oldLauncher.path)).toBe(oldLauncher.content);
    expect(failed.retentionSafe).toBe(true);
    expect(failed.retainedNativeHostPaths).toContain(value.nativeHostPath);
    publish.mockRestore();
    const repaired = await repairChromeExtensionNativeHosts(params);
    expectRepaired(repaired, [params.deps.nativeHostPath]);
  });

  it("refuses unscoped repair and reports malformed registration targets as unsafe for retention", async () => {
    const value = await fixture();
    await expect(repairChromeExtensionNativeHosts(value)).rejects.toThrow("requires --from");
    const root = chromeProductRoots(value.deps)[0]!;
    await fs.mkdir(root.nativeManifestDir, { recursive: true, mode: 0o700 });
    const manifestPath = path.join(root.nativeManifestDir, "ai.openclaw.browser_bootstrap.json");
    await fs.writeFile(manifestPath, "{}\n", { mode: 0o600 });
    const observed = await repairChromeExtensionNativeHosts({ ...value, dryRun: true });
    expect(observed).toMatchObject({ retentionSafe: false, retainedNativeHostPaths: [] });
    expect(observed.warnings).toHaveLength(1);
    expect(await read(manifestPath)).toBe("{}\n");
  });
});
