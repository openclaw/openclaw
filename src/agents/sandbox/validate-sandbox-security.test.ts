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

  it("blocks /etc mount", () => {
    expect(() => validateBindMounts(["/etc/passwd:/mnt/passwd:ro"])).toThrow(
      /blocked path "\/etc"/,
    );
  });

  it("blocks /proc mount", () => {
    expect(() => validateBindMounts(["/proc:/proc:ro"])).toThrow(/blocked path "\/proc"/);
  });

  it("blocks Docker socket mounts (/var/run + /run)", () => {
    expect(() => validateBindMounts(["/var/run/docker.sock:/var/run/docker.sock"])).toThrow(
      /docker\.sock/,
    );
    expect(() => validateBindMounts(["/run/docker.sock:/run/docker.sock"])).toThrow(/docker\.sock/);
  });

  it("blocks parent mounts that would expose the Docker socket", () => {
    expect(() => validateBindMounts(["/run:/run"])).toThrow(/blocked path/);
    expect(() => validateBindMounts(["/var/run:/var/run"])).toThrow(/blocked path/);
    expect(() => validateBindMounts(["/var:/var"])).not.toThrow();
  });

  it("blocks paths with .. traversal to dangerous directories", () => {
    expect(() => validateBindMounts(["/home/user/../../etc/shadow:/mnt/shadow"])).toThrow(
      /blocked path "\/etc"/,
    );
  });

  it("blocks paths with double slashes normalizing to dangerous dirs", () => {
    expect(() => validateBindMounts(["//etc//passwd:/mnt/passwd"])).toThrow(/blocked path "\/etc"/);
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
    expect(() => validateBindMounts(["../etc/passwd:/mnt/passwd"])).toThrow(/non-absolute/);
    expect(() => validateBindMounts(["etc/passwd:/mnt/passwd"])).toThrow(/non-absolute/);
    expect(() => validateBindMounts(["myvol:/mnt"])).toThrow(/non-absolute/);
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
    expect(() => validateNetworkMode("host")).toThrow(/network mode "host" is blocked/);
    expect(() => validateNetworkMode("HOST")).toThrow(/network mode "HOST" is blocked/);
  });
});

describe("validateSeccompProfile", () => {
  it("allows custom profile paths/undefined", () => {
    expect(() => validateSeccompProfile("/tmp/seccomp.json")).not.toThrow();
    expect(() => validateSeccompProfile(undefined)).not.toThrow();
  });

  it("blocks unconfined (case-insensitive)", () => {
    expect(() => validateSeccompProfile("unconfined")).toThrow(
      /seccomp profile "unconfined" is blocked/,
    );
    expect(() => validateSeccompProfile("Unconfined")).toThrow(
      /seccomp profile "Unconfined" is blocked/,
    );
  });
});

describe("validateApparmorProfile", () => {
  it("allows named profile/undefined", () => {
    expect(() => validateApparmorProfile("openclaw-sandbox")).not.toThrow();
    expect(() => validateApparmorProfile(undefined)).not.toThrow();
  });

  it("blocks unconfined (case-insensitive)", () => {
    expect(() => validateApparmorProfile("unconfined")).toThrow(
      /apparmor profile "unconfined" is blocked/,
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
        apparmorProfile: "openclaw-sandbox",
      }),
    ).not.toThrow();
  });
});
