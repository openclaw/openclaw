import fs, { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as doctor from "../browser-doctor.js";
import * as install from "./browser/extension-install-fixture.test-support.js";
import { useExtensionInstallFixture } from "./browser/extension-install.test-support.js";

vi.mock("openclaw/plugin-sdk/text-utility-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/text-utility-runtime")>();
  return {
    ...actual,
    get CONFIG_DIR() {
      return process.env.OPENCLAW_STATE_DIR ?? actual.CONFIG_DIR;
    },
  };
});

const fixture = useExtensionInstallFixture();
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;

afterEach(() => {
  Object.defineProperty(process, "platform", platformDescriptor);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function protectedProfiles(platform: NodeJS.Platform, installed: boolean) {
  const value = await fixture(platform);
  if (installed) {
    await install.installStableChromeExtension(value.bundledDir, value.deps);
  }
  for (const root of install.chromeProductRoots(value.deps)) {
    const profileDir = path.join(root.userDataDir, "Default");
    await fsp.mkdir(profileDir, { recursive: true, mode: 0o700 });
    for (const filename of ["Preferences", "Secure Preferences"]) {
      await fsp.writeFile(path.join(profileDir, filename), "{}", { mode: 0o600 });
    }
  }
  const accesses: string[] = [];
  const denyProfileRead = (target: unknown) => {
    const filename = path.basename(String(target));
    if (["Local State", "Preferences", "Secure Preferences", "Cookies"].includes(filename)) {
      accesses.push(String(target));
      throw Object.assign(new Error("synthetic browser profile access denied"), { code: "EACCES" });
    }
  };
  const readSync = fs.readFileSync;
  vi.spyOn(fs, "readFileSync").mockImplementation((...args) => {
    denyProfileRead(args[0]);
    return readSync(...args);
  });
  const read = fsp.readFile;
  vi.spyOn(fsp, "readFile").mockImplementation(async (...args) => {
    denyProfileRead(args[0]);
    return await read(...args);
  });
  const roots = new Set(install.chromeProductRoots(value.deps).map((root) => root.userDataDir));
  const rootReads = [vi.spyOn(fsp, "lstat"), vi.spyOn(fsp, "readdir")];
  Object.entries(value.deps.env).forEach(([key, entry]) => vi.stubEnv(key, entry));
  vi.stubEnv("OPENCLAW_STATE_DIR", value.stateDir);
  const configHome = path.join(value.homeDir, ".config");
  ["CHROME_CONFIG_HOME", "XDG_CONFIG_HOME"].forEach((key) => vi.stubEnv(key, configHome));
  const rootAccesses = () =>
    rootReads
      .flatMap((spy) => spy.mock.calls.map(([target]) => String(target)))
      .filter((target) => roots.has(target));
  return { ...value, accesses: () => [...accesses, ...rootAccesses()] };
}

it.each([
  ["darwin", false],
  ["darwin", true],
  ["linux", true],
  ["win32", true],
] as const)("does not inspect profiles on %s (installed copy: %s)", async (platform, installed) => {
  const value = await protectedProfiles(platform, installed);
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: platform });
  for (const allowSystemProfileImport of [false, undefined, true]) {
    const noteFn = vi.fn();
    await doctor.noteChromeMcpBrowserReadiness(
      { browser: { allowSystemProfileImport, extensionRelay: { allowLegacyAuth: false } } },
      { noteFn },
    );
    expect(value.accesses()).toEqual([]);
    const notes = noteFn.mock.calls.map(([message]) => String(message)).join("\n");
    if (platform === "darwin") {
      expect(notes).toContain(
        `cookie import is ${allowSystemProfileImport === false ? "disabled" : "enabled"}`,
      );
      expect(notes).toContain("profile discovery skipped");
      expect(notes).not.toContain("cookie databases found:");
    }
    if (installed) {
      expect(notes).toContain("native bootstrap was not inspected");
      expect(notes).toContain("openclaw browser extension status --json");
      expect(notes).not.toContain("not fully registered");
    }
  }
  await install.discoverChromeExtensionIds({ approvedDirs: [], deps: value.deps });
  expect(value.accesses()).toContain(install.chromeProductRoots(value.deps)[0]!.userDataDir);
});

it("reports native-host repair as skipped without discovering profiles or claiming changes", async () => {
  const value = await protectedProfiles(process.platform, true);
  vi.spyOn(os, "homedir").mockReturnValue(value.homeDir);
  const result = await doctor.maybeRepairOwnedChromeExtensionNativeHosts();
  expect(value.accesses()).toEqual([]);
  expect(result).toMatchObject({ changes: [], status: "skipped" });
  expect(result.reason).toContain("Doctor does not inspect personal browser profiles");
  expect(result.warnings.join("\n")).toContain("native-host repair skipped");
  expect(result.warnings.join("\n")).toContain("openclaw browser extension install");
});
