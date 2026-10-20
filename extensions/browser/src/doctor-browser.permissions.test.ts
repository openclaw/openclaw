import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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

function observeRead<A extends unknown[], R>(
  read: (...args: A) => Promise<R>,
  inspect: (target: A[0]) => void,
) {
  return async (...args: A) => {
    inspect(args[0]);
    return await read(...args);
  };
}

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
  vi.spyOn(fsp, "readFile").mockImplementation(observeRead(read, denyProfileRead));
  const roots = new Set(install.chromeProductRoots(value.deps).map((root) => root.userDataDir));
  const recordRoot = (target: unknown) => {
    if (roots.has(String(target))) {
      accesses.push(String(target));
    }
  };
  const lstat = fsp.lstat;
  vi.spyOn(fsp, "lstat").mockImplementation(observeRead(lstat, recordRoot));
  const readdir = fsp.readdir;
  vi.spyOn(fsp, "readdir").mockImplementation(observeRead(readdir, recordRoot));
  for (const [key, entry] of Object.entries(value.deps.env)) {
    vi.stubEnv(key, entry);
  }
  vi.stubEnv("OPENCLAW_STATE_DIR", value.stateDir);
  for (const key of ["CHROME_CONFIG_HOME", "XDG_CONFIG_HOME"]) {
    vi.stubEnv(key, path.join(value.homeDir, ".config"));
  }
  return { ...value, accesses };
}

describe("general Doctor browser profile permission boundary", () => {
  it.each([
    { platform: "darwin", installed: false },
    { platform: "darwin", installed: true },
    { platform: "linux", installed: true },
    { platform: "win32", installed: true },
  ] as const)(
    "does not inspect profiles on $platform (installed copy: $installed)",
    async ({ platform, installed }) => {
      const value = await protectedProfiles(platform, installed);
      Object.defineProperty(process, "platform", { ...platformDescriptor, value: platform });
      for (const allowSystemProfileImport of [false, undefined, true]) {
        const noteFn = vi.fn();
        await doctor.noteChromeMcpBrowserReadiness(
          { browser: { allowSystemProfileImport, extensionRelay: { allowLegacyAuth: false } } },
          { noteFn },
        );
        expect(value.accesses).toEqual([]);
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
      // Explicit discovery must reach the same observer Doctor must leave untouched.
      await install.discoverChromeExtensionIds({ approvedDirs: [], deps: value.deps });
      expect(value.accesses).toContain(install.chromeProductRoots(value.deps)[0]!.userDataDir);
    },
  );

  it("reports native-host repair as skipped without discovering profiles or claiming changes", async () => {
    const value = await protectedProfiles(process.platform, true);
    vi.spyOn(os, "homedir").mockReturnValue(value.homeDir);
    const result = await doctor.maybeRepairOwnedChromeExtensionNativeHosts();
    expect(value.accesses).toEqual([]);
    expect(result.changes).toEqual([]);
    expect(result.status).toBe("skipped");
    expect(result.reason).toContain("Doctor does not inspect personal browser profiles");
    expect(result.warnings.join("\n")).toContain("native-host repair skipped");
    expect(result.warnings.join("\n")).toContain("openclaw browser extension install");
  });
});
