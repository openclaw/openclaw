import { describe, expect, it } from "vitest";
import { probeSandboxCapabilities, supportsSandboxEnvironment } from "./capability-probe.js";

describe("probeSandboxCapabilities", () => {
  it("reports sandbox support when docker CLI is available", () => {
    const probe = probeSandboxCapabilities({
      platform: "darwin",
      hasCommand(command) {
        return command === "docker";
      },
      readProcFile() {
        return null;
      },
    });

    expect(probe.supportsSandbox).toBe(true);
    expect(probe.dockerCliAvailable).toBe(true);
    expect(probe.unshareBinaryAvailable).toBe(false);
    expect(probe.userNamespaceSupport).toBe("unknown");
  });

  it("reports sandbox support on linux when unshare and user namespaces are enabled", () => {
    const probe = probeSandboxCapabilities({
      platform: "linux",
      hasCommand(command) {
        return command === "unshare";
      },
      readProcFile(path) {
        if (path === "/proc/sys/kernel/unprivileged_userns_clone") {
          return "1\n";
        }
        return null;
      },
    });

    expect(probe.supportsSandbox).toBe(true);
    expect(probe.dockerCliAvailable).toBe(false);
    expect(probe.unshareBinaryAvailable).toBe(true);
    expect(probe.userNamespaceSupport).toBe("enabled");
  });

  it("reports no sandbox support on linux when user namespaces are disabled", () => {
    const probe = probeSandboxCapabilities({
      platform: "linux",
      hasCommand(command) {
        return command === "unshare";
      },
      readProcFile(path) {
        if (path === "/proc/sys/kernel/unprivileged_userns_clone") {
          return "0\n";
        }
        return null;
      },
    });

    expect(probe.supportsSandbox).toBe(false);
    expect(probe.userNamespaceSupport).toBe("disabled");
  });

  it("falls back to max_user_namespaces when unprivileged_userns_clone is absent", () => {
    const probe = probeSandboxCapabilities({
      platform: "linux",
      hasCommand(command) {
        return command === "unshare";
      },
      readProcFile(path) {
        if (path === "/proc/sys/user/max_user_namespaces") {
          return "2048\n";
        }
        return null;
      },
    });

    expect(probe.userNamespaceSupport).toBe("enabled");
    expect(probe.supportsSandbox).toBe(true);
  });
});

describe("supportsSandboxEnvironment", () => {
  it("returns the probe boolean", () => {
    expect(
      supportsSandboxEnvironment({
        platform: "linux",
        hasCommand() {
          return false;
        },
        readProcFile() {
          return null;
        },
      }),
    ).toBe(false);
  });
});
