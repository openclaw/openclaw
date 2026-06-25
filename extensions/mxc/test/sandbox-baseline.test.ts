import { describe, expect, test } from "vitest";
import {
  BASELINE_READONLY_PATHS_WINDOWS,
  BASELINE_TIMEOUT_SECONDS,
  computeEffectiveReadonlyPaths,
  computeEffectiveReadwritePaths,
  DEFAULT_SANDBOX_BASELINE,
  resolveBaselineReadonlyPaths,
  resolveSandboxBaseline,
} from "../src/sandbox-baseline.js";

function occurrenceCount(values: readonly string[], expected: string): number {
  return values.filter((value) => value === expected).length;
}

describe("resolveSandboxBaseline", () => {
  test("returns enforceable defaults", () => {
    expect(resolveSandboxBaseline()).toEqual(DEFAULT_SANDBOX_BASELINE);
    expect(resolveSandboxBaseline().filesystem.restrictToProjectDir).toBe(true);
    expect(resolveSandboxBaseline().process.timeoutSeconds).toBe(BASELINE_TIMEOUT_SECONDS);
    expect(resolveSandboxBaseline().process.timeoutSecondsConfigured).toBe(false);
  });

  test("merges partial input with defaults", () => {
    const baseline = resolveSandboxBaseline({
      filesystem: {
        restrictToProjectDir: false,
        additionalReadonlyPaths: ["C:\\tools\\readonly"],
        additionalReadwritePaths: ["C:\\work\\scratch"],
      },
      process: {
        timeoutSeconds: 45,
      },
    });

    expect(baseline.filesystem.restrictToProjectDir).toBe(false);
    expect(baseline.filesystem.additionalReadonlyPaths).toEqual(["C:\\tools\\readonly"]);
    expect(baseline.filesystem.additionalReadwritePaths).toEqual(["C:\\work\\scratch"]);
    expect(baseline.process.timeoutSeconds).toBe(45);
    expect(baseline.process.timeoutSecondsConfigured).toBe(true);
  });

  test("rejects invalid timeout values", () => {
    expect(() => resolveSandboxBaseline({ process: { timeoutSeconds: 0 } })).toThrow(
      /timeoutSeconds/u,
    );
    expect(() => resolveSandboxBaseline({ process: { timeoutSeconds: Number.NaN } })).toThrow(
      /timeoutSeconds/u,
    );
  });
});

describe("effective filesystem policy", () => {
  test("adds baseline readonly directories and policy additions", () => {
    const paths = computeEffectiveReadonlyPaths(
      {
        restrictToProjectDir: true,
        additionalReadonlyPaths: ["C:\\tools", "C:\\tools"],
        additionalReadwritePaths: [],
      },
      {},
    );

    expect(paths).toEqual([...BASELINE_READONLY_PATHS_WINDOWS, "C:\\tools"]);
    expect(occurrenceCount(paths, "C:\\tools")).toBe(1);
  });

  test("derives baseline readonly directories from the host Windows env", () => {
    const paths = computeEffectiveReadonlyPaths(
      {
        restrictToProjectDir: true,
        additionalReadonlyPaths: ["D:\\tools"],
        additionalReadwritePaths: [],
      },
      {
        SystemRoot: "D:\\Windows",
        ProgramFiles: "D:\\Program Files",
        "ProgramFiles(x86)": "D:\\Program Files (x86)",
      },
    );

    expect(paths).toEqual([
      "D:\\Program Files",
      "D:\\Program Files (x86)",
      "D:\\Windows\\System32",
      "D:\\Windows\\SysWOW64",
      "D:\\tools",
    ]);
  });

  test("uses deterministic fallback readonly directories when env values are absent", () => {
    expect(resolveBaselineReadonlyPaths({})).toEqual(BASELINE_READONLY_PATHS_WINDOWS);
  });

  test("readwrite paths include project, temp, and additions", () => {
    const paths = computeEffectiveReadwritePaths({
      projectDir: "C:\\repo\\project",
      tempEnv: { TEMP: "C:\\Temp" },
      additionalReadwritePaths: ["C:\\scratch", "C:\\scratch"],
    });

    expect(paths).toEqual(["C:\\repo\\project", "C:\\Temp", "C:\\scratch"]);
  });

  test("readwrite temp fallback is Windows temp when TEMP and TMP are absent", () => {
    const paths = computeEffectiveReadwritePaths({
      projectDir: "C:\\repo\\project",
      tempEnv: {},
    });

    expect(paths).toEqual(["C:\\repo\\project", "C:\\Windows\\Temp"]);
  });
});
