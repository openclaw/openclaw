import { describe, expect, it, vi } from "vitest";

vi.mock("../src/driver-setup.js", () => ({ inspectFaceTimeDriver: vi.fn(async () => "current") }));

import { resolveFaceTimeConfig } from "../src/config.js";
import { runFaceTimeSetup } from "../src/setup.js";

describe("operator-assisted FaceTime setup", () => {
  it("does not inspect or recommend changing SIP, LLDB, Xcode, or injected helpers", async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const report = await runFaceTimeSetup({
      config: resolveFaceTimeConfig({ ownerHandles: ["owner@example.com"] }),
      nativePackageReady: true,
      pluginRoot: "/plugin",
      runCommandWithTimeout: run as never,
      runtimeStatus: {
        enabled: true,
        controlMode: "operator-assisted",
        admissionModel: "authenticated-operator-confirms-configured-owner",
        carrierHangupSupported: false,
        driverInstallPending: false,
        driverInstall: { phase: "idle" },
        processOutputSuppressed: false,
        calls: [],
      },
      preflight: { ok: true, controlMode: "operator-assisted", checks: [] },
    });
    const serialized = JSON.stringify(report);
    expect(report.controlMode).toBe("operator-assisted");
    expect(serialized).not.toMatch(/csrutil|lldb|injection|inject the helper|Full Xcode/iu);
    expect(run).not.toHaveBeenCalledWith(
      expect.arrayContaining(["/usr/bin/csrutil"]),
      expect.anything(),
    );
  });
});
