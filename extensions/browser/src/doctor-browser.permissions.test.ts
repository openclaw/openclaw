import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectBrowserReadinessFindings } from "../browser-doctor.js";
import {
  chromeProductRoots,
  installStableChromeExtension,
} from "./browser/extension-install-fixture.test-support.js";
import {
  useExtensionInstallFixture,
  writeChromePreferences,
} from "./browser/extension-install.test-support.js";

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
    await installStableChromeExtension(value.bundledDir, value.deps);
  }
  for (const root of chromeProductRoots(value.deps)) {
    for (const filename of ["Preferences", "Secure Preferences"] as const) {
      await writeChromePreferences({
        userDataDir: root.userDataDir,
        profile: "Default",
        filename,
        entries: {},
      });
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
  const roots = new Set(chromeProductRoots(value.deps).map((root) => root.userDataDir));
  const readdir = fsp.readdir;
  vi.spyOn(fsp, "readdir").mockImplementation(async (...args) => {
    if (roots.has(String(args[0]))) {
      accesses.push(String(args[0]));
    }
    return await readdir(...args);
  });
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
      for (const [key, entry] of Object.entries(value.deps.env)) {
        vi.stubEnv(key, entry);
      }
      vi.stubEnv("OPENCLAW_STATE_DIR", value.stateDir);
      for (const allowSystemProfileImport of [false, undefined, true]) {
        const findings = await collectBrowserReadinessFindings({
          browser: { allowSystemProfileImport, extensionRelay: { allowLegacyAuth: false } },
        });
        expect(value.accesses).toEqual([]);
        const notes = findings
          .map((finding) => `${finding.message}\n${finding.fixHint}`)
          .join("\n");
        expect(notes).not.toContain("cookie import");
        expect(notes).not.toContain("profile discovery skipped");
        if (installed) {
          expect(notes).toContain("native bootstrap was not inspected");
          expect(notes).toContain("openclaw browser extension status --json");
          expect(notes).not.toContain("not fully registered");
        }
      }
    },
  );
});
