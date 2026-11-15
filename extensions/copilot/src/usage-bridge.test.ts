// Copilot tests cover usage bridge plugin behavior.
import { describe, expect, it } from "vitest";
import { normalizeCopilotUsage } from "./usage-bridge.js";

describe("usage-bridge", () => {
  describe("normalizeCopilotUsage", () => {
    it("returns undefined for null / non-object input", () => {
      expect(normalizeCopilotUsage(null)).toBeUndefined();
      expect(normalizeCopilotUsage(undefined)).toBeUndefined();
      expect(normalizeCopilotUsage("usage")).toBeUndefined();
    });
  });
});
