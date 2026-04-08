import { describe, expect, it, vi } from "vitest";
import { platform } from "node:process";
import { getSandboxProfileString } from "./bash-tools.exec-runtime.js";

describe("sandbox-exec profiles", () => {
  it("returns a non-empty profile string for 'default'", () => {
    const profile = getSandboxProfileString("default");
    expect(profile).toBeTruthy();
    expect(profile.length).toBeGreaterThan(10);
    expect(profile).toContain("(version 1)");
    expect(profile).toContain("deny network*");
    expect(profile).toContain("file-read*");
    expect(profile).toContain("file-write*");
  });

  it("returns a non-empty profile string for 'permissive'", () => {
    const profile = getSandboxProfileString("permissive");
    expect(profile).toBeTruthy();
    expect(profile.length).toBeGreaterThan(10);
    expect(profile).toContain("(version 1)");
    expect(profile).toContain("allow network*");
  });

  it("default profile denies network by default", () => {
    const profile = getSandboxProfileString("default");
    expect(profile).toContain("(deny network*)");
  });

  it("permissive profile allows network by default", () => {
    const profile = getSandboxProfileString("permissive");
    expect(profile).toContain("(allow network*)");
  });
});

describe("sandbox-exec availability", () => {
  it("platform check is darwin or not", () => {
    // This test just verifies the platform module is accessible
    expect(platform).toBeDefined();
    expect(typeof platform).toBe("string");
  });
});
