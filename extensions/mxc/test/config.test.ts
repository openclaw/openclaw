import { describe, expect, test, vi } from "vitest";
import { resolveConfig } from "../src/config.js";

describe("resolveConfig", () => {
  test("default config from empty/null input", () => {
    const config = resolveConfig(null);
    expect(config).toEqual({
      mxcBinaryPath: undefined,
      containment: "process",
      network: "none",
      timeoutSeconds: 120,
      debug: false,
    });
    const config2 = resolveConfig({});
    expect(config2.containment).toBe("process");
    expect(config2.network).toBe("none");
    expect(config2.timeoutSeconds).toBe(120);
    expect(config2.debug).toBe(false);
    expect(config2).not.toHaveProperty("sandboxBaseline");
  });

  test("all config overrides applied correctly", () => {
    const config = resolveConfig({
      mxcBinaryPath: "C:\\custom\\wxc-exec.exe",
      containment: "processcontainer",
      network: "default",
      timeoutSeconds: 60,
      debug: true,
      readwritePaths: ["C:\\work"],
    });

    expect(config.mxcBinaryPath).toBe("C:\\custom\\wxc-exec.exe");
    expect(config.containment).toBe("processcontainer");
    expect(config.network).toBe("default");
    expect(config.timeoutSeconds).toBe(60);
    expect(config.timeoutSecondsConfigured).toBe(true);
    expect(config.debug).toBe(true);
    expect(config.readwritePaths).toEqual(["C:\\work"]);
  });

  test("sandboxBaseline is not part of plugin config", () => {
    const config = resolveConfig({
      sandboxBaseline: {
        process: { timeoutSeconds: 45 },
      },
    });

    expect(config).not.toHaveProperty("sandboxBaseline");
  });

  test("removed containment values fall back to process without warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const c of [
      "windows_sandbox",
      "wslc",
      "microvm",
      "seatbelt",
      "isolation_session",
      "lxc",
    ]) {
      expect(resolveConfig({ containment: c }).containment).toBe("process");
    }
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  test("empty strings for paths are treated as undefined", () => {
    const config = resolveConfig({
      mxcBinaryPath: "   ",
    });
    expect(config.mxcBinaryPath).toBeUndefined();
  });

  test("invalid containment value falls back to process", () => {
    const config = resolveConfig({ containment: "invalid" });
    expect(config.containment).toBe("process");
  });

  test("supported containment options are accepted", () => {
    for (const c of ["process", "processcontainer"]) {
      const config = resolveConfig({ containment: c });
      expect(config.containment).toBe(c);
    }
  });

  test("invalid network value falls back to none", () => {
    const config = resolveConfig({ network: "allow-all" });
    expect(config.network).toBe("none");
  });

  test("invalid timeoutSeconds falls back to default", () => {
    expect(resolveConfig({ timeoutSeconds: -5 }).timeoutSeconds).toBe(120);
    expect(resolveConfig({ timeoutSeconds: 0 }).timeoutSeconds).toBe(120);
    expect(resolveConfig({ timeoutSeconds: "fast" }).timeoutSeconds).toBe(120);
    expect(resolveConfig({ timeoutSeconds: -5 })).not.toHaveProperty("timeoutSecondsConfigured");
  });
});
