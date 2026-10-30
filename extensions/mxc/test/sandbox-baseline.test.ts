import { describe, expect, test } from "vitest";
import { resolveBaselineReadonlyPaths, resolveSandboxTempDir } from "../src/sandbox-baseline.js";

describe("effective filesystem policy", () => {
  test("uses deterministic readonly fallbacks when Windows env paths are blank", () => {
    expect(
      resolveBaselineReadonlyPaths({
        SystemRoot: "",
        WINDIR: "  ",
        ProgramFiles: " ",
        ProgramW6432: "",
        "ProgramFiles(x86)": "\t",
      }),
    ).toEqual([
      "C:\\Program Files",
      "C:\\Program Files (x86)",
      "C:\\Windows\\System32",
      "C:\\Windows\\SysWOW64",
    ]);
  });

  test("ignores a blank TEMP value when TMP is available", () => {
    expect(resolveSandboxTempDir({ TEMP: "  ", TMP: "D:\\Temp" })).toBe("D:\\Temp");
  });

  test("uses Windows temp when TEMP and TMP are blank", () => {
    expect(resolveSandboxTempDir({ TEMP: "", TMP: "\t" })).toBe("C:\\Windows\\Temp");
  });
});
