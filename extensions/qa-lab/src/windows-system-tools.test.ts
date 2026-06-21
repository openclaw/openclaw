// Qa Lab tests cover Windows system tool path resolution.
import { describe, expect, it } from "vitest";
import {
  resolveQaWindowsSystem32ExePath,
  resolveQaWindowsSystemRoot,
} from "./windows-system-tools.js";

describe("qa-lab windows system tools", () => {
  it("resolves System32 executables from a trusted SystemRoot", () => {
    expect(resolveQaWindowsSystemRoot({ SystemRoot: "D:\\Windows\\" })).toBe("D:\\Windows");
    expect(resolveQaWindowsSystem32ExePath("taskkill.exe", { SystemRoot: "D:\\Windows\\" })).toBe(
      "D:\\Windows\\System32\\taskkill.exe",
    );
  });

  it("falls back to the default Windows root when env roots are unsafe", () => {
    expect(resolveQaWindowsSystem32ExePath("taskkill.exe", { SystemRoot: "C:\\tmp;C:\\bad" })).toBe(
      "C:\\Windows\\System32\\taskkill.exe",
    );
  });

  it("rejects non-basename System32 executable names", () => {
    expect(() => resolveQaWindowsSystem32ExePath("..\\taskkill.exe")).toThrow(
      "Invalid Windows System32 executable name",
    );
    expect(() => resolveQaWindowsSystem32ExePath("taskkill")).toThrow(
      "Invalid Windows System32 executable name",
    );
  });
});
