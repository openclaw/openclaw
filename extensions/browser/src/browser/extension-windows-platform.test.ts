import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  isWindowsNativePath,
  sameWindowsPath,
  sidSchema,
  installationSchema,
  nativeWindowsContextSchema,
} from "./extension-windows-contract.js";
import { createWindowsNativePlatform } from "./extension-windows-platform.js";
import { windowsFixture } from "./extension-windows.test-support.js";
describe("Windows read-only authority and portable path boundaries", () => {
  it.skipIf(process.platform !== "win32")(
    "admits the current runtime beneath protected OS ancestors without changing ownership",
    async () => {
      const ops = createWindowsNativePlatform();
      const identity = await ops.identity();
      expect(isWindowsNativePath(identity.localAppData)).toBe(true);
      expect(sidSchema.safeParse(identity.sid).success).toBe(true);
      await ops.assertPath(await fs.realpath(process.execPath), { kind: "file", private: false });
    },
  );

  it.each([
    "C:relative",
    "\\\\server\\share\\node.exe",
    "\\\\wsl$\\Distro\\node.exe",
    "\\\\?\\C:\\node.exe",
    "C:/node.exe",
    "C:\\a\\..\\node.exe",
    "C:\\a:stream",
    "C:\\CON",
    "C:\\a.",
    "C:\\a ",
    "C:\\a\\",
    "C:\\node.exe\n",
  ])("refuses path alias %j", (value) => {
    expect(isWindowsNativePath(value)).toBe(false);
  });
  it("admits canonical local Unicode spelling without cross-runtime Unicode case folding", () => {
    expect(isWindowsNativePath("C:\\Program Files\\nodejs\\node.exe")).toBe(true);
    expect(isWindowsNativePath("C:\\😀\\node.exe")).toBe(true);
    for (const value of ["\ud800", "\udfff", "a\ud800b", "\udc00\ud800"]) {
      expect(isWindowsNativePath(`C:\\${value}`)).toBe(false);
    }
    expect(sameWindowsPath("C:\\Root\\node.exe", "c:\\ROOT\\NODE.EXE")).toBe(true);
    expect(sameWindowsPath("C:\\é", "C:\\É")).toBe(false);
    expect(isWindowsNativePath("C:\\" + "a".repeat(4093))).toBe(true);
    expect(isWindowsNativePath("C:\\" + "a".repeat(4094))).toBe(false);
  });
  it.each(["", "-a", "A", "a_b", "a.b", "a".repeat(65), " a", "a\n", "a\r", "a\u2028"])(
    "uses canonical whole-input profile grammar %j",
    (browserProfile) => {
      expect(
        nativeWindowsContextSchema.safeParse({ ...windowsFixture().context, browserProfile })
          .success,
      ).toBe(false);
    },
  );
  it.each(["chrome", "0", "a-", "a".repeat(64)])("accepts profile %s", (browserProfile) => {
    expect(
      nativeWindowsContextSchema.safeParse({ ...windowsFixture().context, browserProfile }).success,
    ).toBe(true);
  });
  it("rejects noncanonical SID and GUID scalars", () => {
    expect(sidSchema.safeParse("S-1-5-21-111-222-333-1001").success).toBe(true);
    for (const sid of [
      "s-1-5-21-1",
      "S-1-5-021-1",
      "S-1-5-4294967296",
      "S-1-5-18",
      "S-1-5-21-1\n",
    ]) {
      expect(sidSchema.safeParse(sid).success).toBe(false);
    }
    for (const guid of [
      "-".repeat(36),
      "00000000-0000-0000-0000-000000000000",
      "12345678-1234-4234-8234-123456789ABC",
    ]) {
      expect(
        installationSchema.safeParse({ ...windowsFixture().installation, generation: guid })
          .success,
      ).toBe(false);
    }
  });
  it.skipIf(process.platform === "win32")(
    "cannot discover or mutate Windows authority on a POSIX host",
    async () => {
      const ops = createWindowsNativePlatform();
      await expect(ops.identity()).rejects.toThrow("Windows identity unavailable");
      await expect(
        ops.assertPath("C:\\node.exe", { kind: "file", private: false }),
      ).rejects.toThrow();
    },
  );
});
