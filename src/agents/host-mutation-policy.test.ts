import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertHostMutationAllowed,
  buildSensitiveHostDenyMutations,
  resolveHostToolPath,
} from "./host-mutation-policy.js";

describe("host mutation policy", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("builds deny entries only for privilege and login authority paths", () => {
    const policy = buildSensitiveHostDenyMutations();

    if (process.platform === "win32") {
      expect(policy.paths).toEqual([]);
      expect(policy.prefixes).toEqual([]);
      return;
    }

    expect(policy.paths).toEqual(["/etc/passwd", "/etc/shadow", "/etc/sudoers"].toSorted());
    expect(policy.prefixes).toEqual(["/etc/sudoers.d"]);
    expect(policy.paths).not.toContain(path.join("/tmp", "openclaw-home", ".netrc"));
    expect(policy.prefixes).not.toContain("/etc/systemd");
  });

  it("rejects privilege and login authority mutations", async () => {
    if (process.platform === "win32") {
      return;
    }

    await expect(assertHostMutationAllowed("/etc/passwd")).rejects.toThrow(
      /denied-path|denied|mutation policy/i,
    );
    await expect(assertHostMutationAllowed("/etc/sudoers.d/openclaw-test")).rejects.toThrow(
      /denied-path|denied|mutation policy/i,
    );
    await expect(assertHostMutationAllowed("/tmp/openclaw-not-sensitive")).resolves.toBeUndefined();
  });

  it("expands model tool tildes against the operating-system home", () => {
    const osHome = path.resolve("/tmp/openclaw-os-home");
    const openclawHome = path.resolve("/tmp/openclaw-effective-home");
    vi.stubEnv("HOME", osHome);
    vi.stubEnv("USERPROFILE", osHome);
    vi.stubEnv("OPENCLAW_HOME", openclawHome);

    expect(resolveHostToolPath("~/scratch.txt")).toBe(path.join(osHome, "scratch.txt"));
  });
});
