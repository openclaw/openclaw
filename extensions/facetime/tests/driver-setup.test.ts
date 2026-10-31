import { describe, expect, it, vi } from "vitest";
import { commandResult } from "../../test-support/command-result.test-support.js";
import { installFaceTimeDriver, uninstallFaceTimeDriver } from "../src/driver-setup.js";

describe("FaceTime driver setup", () => {
  it.each([
    {
      install: true,
      stderr: "denied",
      stdout: "ignored",
      expected: "audio driver installation failed: denied",
    },
    {
      install: false,
      stderr: "denied",
      stdout: "ignored",
      expected: "uninstall failed: denied",
    },
    { install: false, stderr: "", stdout: "failed", expected: "uninstall failed: failed" },
    { install: true, stderr: "", stdout: "", expected: "audio driver installation failed: exit 7" },
  ])("reports the driver failure: $expected", async ({ install, stderr, stdout, expected }) => {
    const runCommandWithTimeout = vi
      .fn<Parameters<typeof installFaceTimeDriver>[0]["runCommandWithTimeout"]>()
      .mockResolvedValue(commandResult({ code: 7, stdout, stderr }));
    if (install) {
      runCommandWithTimeout.mockResolvedValueOnce(commandResult({ stdout: "missing\n" }));
    }
    const operation = install ? installFaceTimeDriver : uninstallFaceTimeDriver;
    await expect(operation({ pluginRoot: "/tmp/facetime", runCommandWithTimeout })).rejects.toThrow(
      `FaceTime ${expected}`,
    );
  });

  it("does not prompt or restart CoreAudio when the driver is current", async () => {
    const runCommandWithTimeout = vi.fn().mockResolvedValue({
      code: 0,
      stdout: "current\n",
      stderr: "",
    });

    await expect(
      installFaceTimeDriver({
        pluginRoot: "/tmp/facetime",
        runCommandWithTimeout: runCommandWithTimeout as never,
      }),
    ).resolves.toEqual({ changed: false, status: "current" });
    expect(runCommandWithTimeout).toHaveBeenCalledExactlyOnceWith(
      ["/bin/sh", "/tmp/facetime/scripts/install-driver.sh", "--status"],
      { timeoutMs: 10_000 },
    );
  });

  it("installs and verifies a missing driver", async () => {
    const abortController = new AbortController();
    const runCommandWithTimeout = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: "missing\n", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "Installed\n", stderr: "" });

    await expect(
      installFaceTimeDriver({
        pluginRoot: "/tmp/facetime",
        runCommandWithTimeout: runCommandWithTimeout as never,
        signal: abortController.signal,
      }),
    ).resolves.toEqual({ changed: true, status: "current" });
    expect(runCommandWithTimeout).toHaveBeenCalledTimes(2);
    expect(runCommandWithTimeout).toHaveBeenNthCalledWith(
      2,
      ["/bin/sh", "/tmp/facetime/scripts/install-driver.sh", "--ensure"],
      { killProcessTree: true, signal: abortController.signal },
    );
  });

  it("runs the explicit process-tree-bound uninstall contract", async () => {
    const abortController = new AbortController();
    const runCommandWithTimeout = vi.fn().mockResolvedValue({
      code: 0,
      stdout: "Removed\n",
      stderr: "",
    });

    await uninstallFaceTimeDriver({
      pluginRoot: "/tmp/facetime",
      runCommandWithTimeout: runCommandWithTimeout as never,
      signal: abortController.signal,
    });

    expect(runCommandWithTimeout).toHaveBeenCalledWith(
      ["/bin/sh", "/tmp/facetime/scripts/install-driver.sh", "--uninstall"],
      { killProcessTree: true, signal: abortController.signal },
    );
  });
});
