import { describe, expect, it } from "vitest";
import { checkPythonEnvironment } from "./python-check.js";

describe("checkPythonEnvironment", () => {
  it("returns ok when python3 is available with correct version", async () => {
    const result = await checkPythonEnvironment({ pythonCommand: "python3" });
    expect(result).toHaveProperty("ok");
    if (result.ok) {
      expect(result.pythonVersion).toMatch(/^3\.\d+/);
    } else {
      expect(result.reason).toBeDefined();
      expect(result.setupInstructions).toBeDefined();
    }
  });

  it("returns not-ok for a bogus python command", async () => {
    const result = await checkPythonEnvironment({
      pythonCommand: "python-nonexistent-xyzzy",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("missing-command");
    }
  });

  it("parses Python version strings correctly", async () => {
    const { parsePythonVersion } = await import("./python-check.js");
    expect(parsePythonVersion("Python 3.9.7")).toBe("3.9.7");
    expect(parsePythonVersion("Python 3.10.0")).toBe("3.10.0");
  });

  it("meetsMinVersion correctly compares versions", async () => {
    const { meetsMinVersion } = await import("./python-check.js");
    expect(meetsMinVersion("3.10.0", "3.10")).toBe(true);
    expect(meetsMinVersion("3.12.1", "3.10")).toBe(true);
    expect(meetsMinVersion("3.9.7", "3.10")).toBe(false);
    expect(meetsMinVersion("2.7.18", "3.10")).toBe(false);
  });
});

describe("resolveJarvisPath", () => {
  it("returns the explicit path when provided", async () => {
    const { resolveJarvisPath } = await import("./python-check.js");
    const result = resolveJarvisPath("/explicit/path");
    expect(result).toBe("/explicit/path");
  });

  it("probes well-known plugin cache locations", async () => {
    const { JARVIS_PROBE_PATHS } = await import("./python-check.js");
    expect(JARVIS_PROBE_PATHS.length).toBeGreaterThan(0);
    for (const p of JARVIS_PROBE_PATHS) {
      expect(p).toContain("jarvis");
    }
  });
});
