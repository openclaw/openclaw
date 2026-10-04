import { expect, it } from "vitest";
import { buildCrabboxAllocationArgs, parseCrabboxProfile } from "./crabbox-worker-profile.js";

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
