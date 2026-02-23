import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getBlockedBindReason,
  validateBindMounts,
  validateNetworkMode,
  validateSeccompProfile,
  validateApparmorProfile,
  validateSandboxSecurity,
} from "./validate-sandbox-security.js";

function expectBindMountsToThrow(binds: string[], expected: RegExp, label: string) {
  expect(() => validateBindMounts(binds), label).toThrow(expected);
}

describe("getBlockedBindReason", () => {
  it("blocks common Docker socket directories", () => {
    expect(getBlockedBindReason("/run:/run")).toEqual(expect.objectContaining({ kind: "targets" }));
    expect(getBlockedBindReason("/var/run:/var/run:ro")).toEqual(
      expect.objectContaining({ kind: "targets" }),
    );
  });

  it("does not block /var by default", () => {
    expect(getBlockedBindReason("/var:/var")).toBeNull();
  });
});

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

  it("blocks dangerous bind source paths", () => {
    const cases = [
      {
        name: "etc mount",
        binds: ["/etc/passwd:/mnt/passwd:ro"],
        expected: /blocked path "\/etc"/,
      },
      {
        name: "proc mount",
        binds: ["/proc:/proc:ro"],
        expected: /blocked path "\/proc"/,
      },
      {
        name: "docker socket in /var/run",
        binds: ["/var/run/docker.sock:/var/run/docker.sock"],
        expected: /docker\.sock/,
      },
      {
        name: "docker socket in /run",
        binds: ["/run/docker.sock:/run/docker.sock"],
        expected: /docker\.sock/,
      },
      {
        name: "parent /run mount",
        binds: ["/run:/run"],
        expected: /blocked path/,
      },
      {
        name: "parent /var/run mount",
        binds: ["/var/run:/var/run"],
        expected: /blocked path/,
      },
      {
        name: "traversal into /etc",
        binds: ["/home/user/../../etc/shadow:/mnt/shadow"],
        expected: /blocked path "\/etc"/,
      },
      {
        name: "double-slash normalization into /etc",
        binds: ["//etc//passwd:/mnt/passwd"],
        expected: /blocked path "\/etc"/,
      },
    ] as const;
    for (const testCase of cases) {
      expectBindMountsToThrow([...testCase.binds], testCase.expected, testCase.name);
    }
  });

  it("allows parent mounts that are not blocked", () => {
    expect(() => validateBindMounts(["/var:/var"])).not.toThrow();
  });

  it("blocks symlink escapes into blocked directories", () => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw-sbx-"));
    const link = join(dir, "etc-link");
    symlinkSync("/etc", link);
    const run = () => validateBindMounts([`${link}/passwd:/mnt/passwd:ro`]);

    if (process.platform === "win32") {
      // Windows source paths (e.g. C:\...) are intentionally rejected as non-POSIX.
      expect(run).toThrow(/non-absolute source path/);
      return;
    }

    expect(run).toThrow(/blocked path/);
  });

  it("rejects non-absolute source paths (relative or named volumes)", () => {
    const cases = ["../etc/passwd:/mnt/passwd", "etc/passwd:/mnt/passwd", "myvol:/mnt"] as const;
    for (const source of cases) {
      expectBindMountsToThrow([source], /non-absolute/, source);
    }
  });
});

describe("validateNetworkMode", () => {
  it("allows bridge/none/custom/undefined", () => {
    expect(() => validateNetworkMode("bridge")).not.toThrow();
    expect(() => validateNetworkMode("none")).not.toThrow();
    expect(() => validateNetworkMode("my-custom-network")).not.toThrow();
    expect(() => validateNetworkMode(undefined)).not.toThrow();
  });

  it("blocks host mode (case-insensitive)", () => {
    const cases = [
      { mode: "host", expected: /network mode "host" is blocked/ },
      { mode: "HOST", expected: /network mode "HOST" is blocked/ },
    ] as const;
    for (const testCase of cases) {
      expect(() => validateNetworkMode(testCase.mode), testCase.mode).toThrow(testCase.expected);
    }
  });
});

describe("validateSeccompProfile", () => {
  it("allows custom profile paths/undefined", () => {
    expect(() => validateSeccompProfile("/tmp/seccomp.json")).not.toThrow();
    expect(() => validateSeccompProfile(undefined)).not.toThrow();
  });
});

describe("validateApparmorProfile", () => {
  it("allows named profile/undefined", () => {
    expect(() => validateApparmorProfile("openclaw-sandbox")).not.toThrow();
    expect(() => validateApparmorProfile(undefined)).not.toThrow();
  });
});

describe("profile hardening", () => {
  it.each([
    {
      name: "seccomp",
      run: (value: string) => validateSeccompProfile(value),
      expected: /seccomp profile ".+" is blocked/,
    },
    {
      name: "apparmor",
      run: (value: string) => validateApparmorProfile(value),
      expected: /apparmor profile ".+" is blocked/,
    },
  ])("blocks unconfined profiles (case-insensitive): $name", ({ run, expected }) => {
    expect(() => run("unconfined")).toThrow(expected);
    expect(() => run("Unconfined")).toThrow(expected);
  });
});

describe("validateSandboxSecurity", () => {
  it("passes with safe config", () => {
    expect(() =>
      validateSandboxSecurity({
        binds: ["/home/user/src:/src:rw"],
        network: "none",
        seccompProfile: "/tmp/seccomp.json",
        apparmorProfile: "openclaw-sandbox",
      }),
    ).not.toThrow();
  });
});
