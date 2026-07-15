// Qa Matrix tests cover Windows system tool path resolution.
import { describe, expect, it } from "vitest";
import { resolveMatrixQaWindowsSystem32ExePath } from "./windows-system-tools.js";

describe("qa-matrix windows system tools", () => {
  it("resolves System32 executables from a trusted SystemRoot", () => {
    expect(
      resolveMatrixQaWindowsSystem32ExePath("taskkill.exe", { SystemRoot: "D:\\Windows\\" }),
    ).toBe("D:\\Windows\\System32\\taskkill.exe");
  });

  it("falls back to the default Windows root when env roots are unsafe", () => {
    expect(
      resolveMatrixQaWindowsSystem32ExePath("taskkill.exe", {
        WINDIR: "\\\\attacker\\share",
      }),
    ).toBe("C:\\Windows\\System32\\taskkill.exe");
  });

  it("rejects non-basename System32 executable names", () => {
    expect(() => resolveMatrixQaWindowsSystem32ExePath("..\\taskkill.exe")).toThrow(
      "Invalid Windows System32 executable name",
    );
    expect(() => resolveMatrixQaWindowsSystem32ExePath("taskkill")).toThrow(
      "Invalid Windows System32 executable name",
    );
  });
});
