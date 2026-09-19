import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chromeProductRoots } from "./extension-install-layout.js";
import { installChromeExtensionBootstrap } from "./extension-install.js";
import {
  FOUNDATION_STORE_ID,
  useExtensionInstallFixture,
  writeChromePreferences,
} from "./extension-install.test-support.js";

const fixture = useExtensionInstallFixture();

afterEach(() => {
  vi.restoreAllMocks();
});

describe("native host publication recovery", () => {
  it.each(["launcher", "manifest"] as const)(
    "cleans up a failed %s publication and allows a same-process retry",
    async (target) => {
      const value = await fixture();
      const chrome = chromeProductRoots(value.deps).find((root) => root.product === "chrome");
      if (!chrome) {
        throw new Error("missing Chrome fixture root");
      }
      await writeChromePreferences({
        userDataDir: chrome.userDataDir,
        profile: "Default",
        entries: { [FOUNDATION_STORE_ID]: { location: 1, from_webstore: true } },
      });
      const params = {
        bundledDir: value.bundledDir,
        pluginRoot: value.pluginRoot,
        waitMs: 1_000,
        requestStoreInstall: false,
      };
      const before = await installChromeExtensionBootstrap({ ...params, deps: value.deps });
      expect(before.issues).toEqual([]);
      const registration = before.registrations.find((entry) => entry.product === "chrome");
      if (!registration) {
        throw new Error("missing Chrome fixture registration");
      }
      const manifest = JSON.parse(await fs.readFile(registration.manifestPath, "utf8")) as {
        path: string;
      };
      const targetPath = target === "launcher" ? manifest.path : registration.manifestPath;
      const targetBytes = await fs.readFile(targetPath, "utf8");
      const directory = path.dirname(targetPath);
      const entries = (await fs.readdir(directory)).toSorted();
      const nativeHostPath = path.join(value.root, "replacement-native-host.js");
      await fs.writeFile(nativeHostPath, "export {};\n", { mode: 0o600 });
      const deps = { ...value.deps, nativeHostPath };
      const rename = fs.rename.bind(fs);
      let interrupted = false;
      const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
        if (!interrupted && destination === targetPath) {
          interrupted = true;
          throw Object.assign(new Error("native host publication failed"), { code: "EIO" });
        }
        await rename(source, destination);
      });

      const failed = await installChromeExtensionBootstrap({ ...params, deps });
      renameSpy.mockRestore();
      expect(failed.issues.join("\n")).toContain("native host publication failed");
      expect(await fs.readFile(targetPath, "utf8")).toBe(targetBytes);
      expect.soft((await fs.readdir(directory)).toSorted()).toEqual(entries);

      const retried = await installChromeExtensionBootstrap({ ...params, deps });
      expect(retried.issues).toEqual([]);
      expect(retried.manualSetupRequired).toBe(false);
      expect(retried.registrations).toEqual(before.registrations);
      expect(await fs.readFile(manifest.path, "utf8")).toContain(nativeHostPath);
      expect((await fs.readdir(directory)).toSorted()).toEqual(entries);
      if (process.platform !== "win32") {
        expect((await fs.stat(registration.manifestPath)).mode & 0o777).toBe(0o600);
        expect((await fs.stat(manifest.path)).mode & 0o777).toBe(0o700);
      }
    },
  );
});
