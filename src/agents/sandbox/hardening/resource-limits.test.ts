import { describe, it, expect } from "vitest";
import type { ResourceLimits } from "../types.js";
import { buildResourceLimitFlags, DEFAULT_RESOURCE_LIMITS } from "./resource-limits.js";

describe("resource-limits", () => {
  describe("buildResourceLimitFlags", () => {
    it("builds full flag set from complete config", () => {
      const flags = buildResourceLimitFlags({
        cpus: 1,
        memoryMB: 512,
        pidsLimit: 256,
      });
      expect(flags).toEqual(["--cpus=1", "--memory=512m", "--pids-limit=256"]);
    });

    it("builds partial flags from partial config", () => {
      const flags = buildResourceLimitFlags({ cpus: 0.5 });
      expect(flags).toEqual(["--cpus=0.5"]);
    });

    it("returns empty array for empty config", () => {
      const flags = buildResourceLimitFlags({});
      expect(flags).toEqual([]);
    });

    it("handles memoryMB-only config", () => {
      const flags = buildResourceLimitFlags({ memoryMB: 1024 });
      expect(flags).toEqual(["--memory=1024m"]);
    });

    it("handles pidsLimit-only config", () => {
      const flags = buildResourceLimitFlags({ pidsLimit: 100 });
      expect(flags).toEqual(["--pids-limit=100"]);
    });
  });

  describe("DEFAULT_RESOURCE_LIMITS", () => {
    it("has sensible defaults", () => {
      expect(DEFAULT_RESOURCE_LIMITS).toEqual({
        cpus: 1,
        memoryMB: 512,
        pidsLimit: 256,
      });
    });

    it("satisfies ResourceLimits type", () => {
      const _check: ResourceLimits = DEFAULT_RESOURCE_LIMITS;
      expect(_check).toBeDefined();
    });
  });
});
