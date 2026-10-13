import { expect, it } from "vitest";
import {
  buildCrabboxAllocationArgs,
  parseCrabboxProfile,
  resolveCrabboxWarmImageProfileKey,
} from "./crabbox-worker-profile.js";

it("explicitly requests Linux when the profile uses the default target", () => {
  const profile = parseCrabboxProfile({ provider: "aws", ttl: "24h", idleTimeout: "60m" });
  expect(buildCrabboxAllocationArgs(profile, "cbx_linux", "linux-worker")).toEqual([
    "--provider",
    "aws",
    "--network",
    "public",
    "--tailscale=false",
    "--target",
    "linux",
    "--ttl",
    "24h",
    "--idle-timeout",
    "60m",
    "--lease-id",
    "cbx_linux",
    "--slug",
    "linux-worker",
    "--keep=true",
  ]);
});

it("keys snapshots by resolved disk inputs while ignoring allocation policy", () => {
  const profile = parseCrabboxProfile({
    provider: "AWS",
    class: "standard",
    ttl: "24h",
    idleTimeout: "60m",
    setup: "install-tools",
    setupEnv: ["SECOND", "FIRST"],
  });
  const key = resolveCrabboxWarmImageProfileKey(profile, "project-a");
  // Existing allocation rows keep this key when the preparation contract changes.
  expect(key).toBe("94d5e2bed9c520eb30e92546173acae225ba557b9af4795ec1f95afa0d3fe178");
  expect(
    resolveCrabboxWarmImageProfileKey(
      {
        ...profile,
        ttl: "48h",
        idleTimeout: "120m",
        idleTimeoutMs: 7_200_000,
        heartbeatIntervalMs: 1234,
        heartbeatTimeoutMs: 5678,
        binary: "/other/crabbox",
        warmImage: true,
        desktop: false,
        setupEnv: ["FIRST", "SECOND"],
      },
      "project-a",
    ),
  ).toBe(key);
  for (const changed of [
    { ...profile, provider: "hetzner" },
    { ...profile, class: "fast" },
    { ...profile, setup: "install-other-tools" },
    { ...profile, setupEnv: ["OTHER"] },
    { ...profile, desktop: true },
    { ...profile, target: "macos" as const },
  ]) {
    expect(resolveCrabboxWarmImageProfileKey(changed, "project-a")).not.toBe(key);
  }
  expect(resolveCrabboxWarmImageProfileKey(profile, "project-b")).not.toBe(key);
});
