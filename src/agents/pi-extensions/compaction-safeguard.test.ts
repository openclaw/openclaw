import { describe, it, expect } from "vitest";
import {
  setCompactionSafeguardRuntime,
  getCompactionSafeguardRuntime,
  CompactionSafeguardRuntimeValue,
} from "../compaction-safeguard-runtime";

describe("compaction-safeguard-runtime", () => {
  describe("reserveTokens handling", () => {
    it("should set and retrieve reserveTokens", () => {
      const mockManager = {};
      const value: CompactionSafeguardRuntimeValue = {
        reserveTokens: 20000,
        maxHistoryShare: 0.3,
        contextWindowTokens: 100000,
      };

      setCompactionSafeguardRuntime(mockManager, value);
      const retrieved = getCompactionSafeguardRuntime(mockManager);

      expect(retrieved).toEqual(value);
      expect(retrieved?.reserveTokens).toBe(20000);
    });

    it("should handle undefined reserveTokens", () => {
      const mockManager = {};
      const value: CompactionSafeguardRuntimeValue = {
        maxHistoryShare: 0.3,
        contextWindowTokens: 100000,
      };

      setCompactionSafeguardRuntime(mockManager, value);
      const retrieved = getCompactionSafeguardRuntime(mockManager);

      expect(retrieved).toEqual(value);
      expect(retrieved?.reserveTokens).toBeUndefined();
    });

    it("should handle edge cases", () => {
      const mockManager = {};

      // Test zero value
      setCompactionSafeguardRuntime(mockManager, { reserveTokens: 0 });
      let retrieved = getCompactionSafeguardRuntime(mockManager);
      expect(retrieved?.reserveTokens).toBe(0);

      // Test null clears registry
      setCompactionSafeguardRuntime(mockManager, null);
      retrieved = getCompactionSafeguardRuntime(mockManager);
      expect(retrieved).toBeNull();
    });
  });
});
