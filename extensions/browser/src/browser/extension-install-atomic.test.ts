import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useInstallFixture } from "./extension-install-fixture.test-support.js";
import { FOUNDATION_STORE_ID } from "./extension-install.test-support.js";

const fixture = useInstallFixture();

afterEach(() => vi.restoreAllMocks());
const readManifest = async (file: string): Promise<{ path: string }> =>
  JSON.parse(await fs.readFile(file, "utf8"));
const list = async (directory: string) => (await fs.readdir(directory)).toSorted();

it.each(["launcher", "manifest"] as const)(
  "cleans up a failed %s publication and allows a same-process retry",
  async (target) => {
    const value = await fixture();
    await value.preferences({ [FOUNDATION_STORE_ID]: { location: 1, from_webstore: true } });
    const install = (deps = value.deps) => value.install({ deps, requestStoreInstall: false });
    const before = await install();
    expect(before.issues).toEqual([]);
    const registration = before.registrations.find((entry) => entry.product === "chrome");
    assert(registration, "missing Chrome fixture registration");
    const manifest = await readManifest(registration.manifestPath);
    const targetPath = target === "launcher" ? manifest.path : registration.manifestPath;
    const targetBytes = await fs.readFile(targetPath, "utf8");
    const directory = path.dirname(targetPath);
    const entries = await list(directory);
    const nativeHostPath = path.join(value.root, "replacement-native-host.js");
    await fs.writeFile(nativeHostPath, "export {};\n", { mode: 0o600 });
    const deps = { ...value.deps, nativeHostPath };
    const rename = fs.rename.bind(fs);
    let interrupted = false;
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      const selectedTarget =
        target === "manifest"
          ? destination === targetPath
          : path.dirname(String(destination)) === directory && String(destination).endsWith(".sh");
      if (!interrupted && selectedTarget) {
        interrupted = true;
        throw Object.assign(new Error("native host publication failed"), { code: "EIO" });
      }
      await rename(source, destination);
    });

    const failed = await install(deps);
    renameSpy.mockRestore();
    expect(failed.issues.join("\n")).toContain("native host publication failed");
    expect(await fs.readFile(targetPath, "utf8")).toBe(targetBytes);
    expect.soft(await list(directory)).toEqual(entries);

    const retried = await install(deps);
    expect(retried).toMatchObject({ issues: [], manualSetupRequired: false });
    expect(retried.registrations).toEqual(before.registrations);
    const current = await readManifest(registration.manifestPath);
    expect(await fs.readFile(current.path, "utf8")).toContain(nativeHostPath);
    const oldLauncher = path.basename(manifest.path);
    const newLauncher = path.basename(current.path);
    const replaced = entries
      .map((entry) => (entry === oldLauncher ? newLauncher : entry))
      .toSorted();
    expect(await list(directory)).toEqual(target === "launcher" ? replaced : entries);
    await expect(fs.stat(manifest.path)).rejects.toMatchObject({ code: "ENOENT" });
    if (process.platform !== "win32") {
      expect((await fs.stat(registration.manifestPath)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(current.path)).mode & 0o777).toBe(0o700);
    }
  },
);
