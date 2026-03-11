import { describe, it, expect } from "vitest";
import type { NetworkMode } from "../types.js";
import { buildNetworkFlag } from "./network-isolation.js";

describe("network-isolation", () => {
  describe("buildNetworkFlag", () => {
    it('builds --network=none for "none" mode', () => {
      expect(buildNetworkFlag("none")).toEqual(["--network=none"]);
    });

    it('builds --network=bridge for "bridge" mode', () => {
      expect(buildNetworkFlag("bridge")).toEqual(["--network=bridge"]);
    });

    it('builds --network=host for "host" mode', () => {
      expect(buildNetworkFlag("host")).toEqual(["--network=host"]);
    });

    it("accepts NetworkMode type values", () => {
      const mode: NetworkMode = "none";
      const flags = buildNetworkFlag(mode);
      expect(flags).toHaveLength(1);
      expect(flags[0]).toContain("--network=");
    });
  });
});
