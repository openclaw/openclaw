import { describe, it, expect } from "vitest";
import { buildNetworkFlag, type NetworkMode } from "./network-isolation.js";

describe("network-isolation", () => {
  describe("buildNetworkFlag", () => {
    it('builds --network=none for "none" mode', () => {
      expect(buildNetworkFlag("none")).toEqual(["--network=none"]);
    });

    it('builds --network=bridge for "bridge" mode', () => {
      expect(buildNetworkFlag("bridge")).toEqual(["--network=bridge"]);
    });

    it("builds --network flag for custom network name", () => {
      expect(buildNetworkFlag("my-custom-net")).toEqual(["--network=my-custom-net"]);
    });

    it("accepts NetworkMode type values", () => {
      const mode: NetworkMode = "none";
      const flags = buildNetworkFlag(mode);
      expect(flags).toHaveLength(1);
      expect(flags[0]).toContain("--network=");
    });
  });
});
