// Copilot tests cover usage bridge plugin behavior.
import { describe, expect, it } from "vitest";
import { buildCopilotAssistantUsage, normalizeCopilotUsage } from "./usage-bridge.js";

const ZERO_ASSISTANT_USAGE = {
  cacheRead: 0,
  cacheWrite: 0,
  cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
  input: 0,
  output: 0,
  totalTokens: 0,
};

describe("usage-bridge", () => {
  describe("normalizeCopilotUsage", () => {
    it("returns undefined for null / non-object input", () => {
      expect(normalizeCopilotUsage(null)).toBeUndefined();
      expect(normalizeCopilotUsage(undefined)).toBeUndefined();
      expect(normalizeCopilotUsage("usage")).toBeUndefined();
    });
  });

  describe("buildCopilotAssistantUsage", () => {
    it("defaults missing usage fields to zero in the rich block only", () => {
      expect(
        buildCopilotAssistantUsage({
          usage: { input: 4 },
        }),
      ).toEqual({
        ...ZERO_ASSISTANT_USAGE,
        input: 4,
      });
    });
  });
});
