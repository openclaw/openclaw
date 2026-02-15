import { describe, expect, it } from "vitest";
import {
  validateBindMounts,
  validateNetworkMode,
  validateSeccompProfile,
  validateSandboxSecurity,
} from "./validate-sandbox-security.js";

describe("validateBindMounts", () => {
  it("allows legitimate project directory mounts", () => {
    expect(() =>
      validateBindMounts([
        "/home/user/source:/source:rw",
        "/home/user/projects:/projects:ro",
        "/var/data/myapp:/data",
        "/opt/myapp/config:/config:ro",
      ]),
    ).not.toThrow();
  });

  it("allows undefined or empty binds", () => {
    expect(() => validateBindMounts(undefined)).not.toThrow();
    expect(() => validateBindMounts([])).not.toThrow();
  });

  it("blocks /etc mount", () => {
    expect(() => validateBindMounts(["/etc/passwd:/mnt/passwd:ro"])).toThrow(
      /blocked path "\/etc"/,
    );
  });

  it("blocks /proc mount", () => {
    expect(() => validateBindMounts(["/proc:/proc:ro"])).toThrow(/blocked path "\/proc"/);
  });

  it("blocks /sys mount", () => {
    expect(() => validateBindMounts(["/sys:/sys"])).toThrow(/blocked path "\/sys"/);
  });

  it("blocks /dev mount", () => {
    expect(() => validateBindMounts(["/dev:/dev"])).toThrow(/blocked path "\/dev"/);
  });

  it("blocks /root mount", () => {
    expect(() => validateBindMounts(["/root:/mnt/root:ro"])).toThrow(/blocked path "\/root"/);
  });

  it("blocks /boot mount", () => {
    expect(() => validateBindMounts(["/boot:/mnt/boot"])).toThrow(/blocked path "\/boot"/);
  });

  it("blocks Docker socket mount", () => {
    expect(() => validateBindMounts(["/var/run/docker.sock:/var/run/docker.sock"])).toThrow(
      /blocked path "\/var\/run\/docker.sock"/,
    );
  });

  it("blocks paths with .. traversal to dangerous directories", () => {
    expect(() => validateBindMounts(["/home/user/../../etc/shadow:/mnt/shadow"])).toThrow(
      /blocked path "\/etc"/,
    );
  });

  it("blocks paths with double slashes normalizing to dangerous dirs", () => {
    expect(() => validateBindMounts(["//etc//passwd:/mnt/passwd"])).toThrow(/blocked path "\/etc"/);
  });

  it("blocks subdirectories of dangerous paths", () => {
    expect(() => validateBindMounts(["/etc/ssh:/ssh:ro"])).toThrow(/blocked path "\/etc"/);
    expect(() => validateBindMounts(["/proc/1/root:/mnt"])).toThrow(/blocked path "\/proc"/);
  });

  it("does NOT block /var/data (not in targeted denylist)", () => {
    expect(() => validateBindMounts(["/var/data/myapp:/data"])).not.toThrow();
  });

  it("does NOT block /home paths", () => {
    expect(() => validateBindMounts(["/home/user/myproject:/project"])).not.toThrow();
  });
});

describe("validateNetworkMode", () => {
  it("allows bridge mode", () => {
    expect(() => validateNetworkMode("bridge")).not.toThrow();
  });

  it("allows none mode", () => {
    expect(() => validateNetworkMode("none")).not.toThrow();
  });

  it("allows custom network names", () => {
    expect(() => validateNetworkMode("my-custom-network")).not.toThrow();
  });

  it("allows undefined", () => {
    expect(() => validateNetworkMode(undefined)).not.toThrow();
  });

  it("blocks host mode", () => {
    expect(() => validateNetworkMode("host")).toThrow(/network mode "host" is blocked/);
  });

  it("blocks host mode case-insensitively", () => {
    expect(() => validateNetworkMode("Host")).toThrow(/network mode "Host" is blocked/);
    expect(() => validateNetworkMode("HOST")).toThrow(/network mode "HOST" is blocked/);
  });
});

describe("validateSeccompProfile", () => {
  it("allows custom profile paths", () => {
    expect(() => validateSeccompProfile("/tmp/seccomp.json")).not.toThrow();
  });

  it("allows undefined", () => {
    expect(() => validateSeccompProfile(undefined)).not.toThrow();
  });

  it("blocks unconfined", () => {
    expect(() => validateSeccompProfile("unconfined")).toThrow(
      /seccomp profile "unconfined" is blocked/,
    );
  });

  it("blocks unconfined case-insensitively", () => {
    expect(() => validateSeccompProfile("Unconfined")).toThrow(
      /seccomp profile "Unconfined" is blocked/,
    );
  });
});

describe("validateSandboxSecurity", () => {
  it("passes with safe config", () => {
    expect(() =>
      validateSandboxSecurity({
        binds: ["/home/user/src:/src:rw"],
        network: "none",
        seccompProfile: "/tmp/seccomp.json",
      }),
    ).not.toThrow();
  });

  it("throws on dangerous bind even with safe network/seccomp", () => {
    expect(() =>
      validateSandboxSecurity({
        binds: ["/etc/passwd:/mnt/passwd"],
        network: "none",
      }),
    ).toThrow(/blocked path/);
  });

  it("throws on host network even with safe binds", () => {
    expect(() =>
      validateSandboxSecurity({
        binds: ["/home/user/src:/src"],
        network: "host",
      }),
    ).toThrow(/network mode "host" is blocked/);
  });

  it("throws on unconfined seccomp even with safe binds/network", () => {
    expect(() =>
      validateSandboxSecurity({
        network: "none",
        seccompProfile: "unconfined",
      }),
    ).toThrow(/seccomp profile "unconfined" is blocked/);
  });
});
