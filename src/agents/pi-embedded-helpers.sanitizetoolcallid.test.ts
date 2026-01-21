import { describe, expect, it } from "vitest";
import { sanitizeToolCallId } from "./pi-embedded-helpers.js";

describe("sanitizeToolCallId", () => {
  describe("standard mode (default)", () => {
    it("keeps valid alphanumeric tool call IDs", () => {
      expect(sanitizeToolCallId("callabc123")).toBe("callabc123");
    });
    it("keeps underscores and hyphens for readability", () => {
      expect(sanitizeToolCallId("call_abc-123")).toBe("call_abc-123");
      expect(sanitizeToolCallId("call_abc_def")).toBe("call_abc_def");
    });
    it("replaces invalid characters with underscores", () => {
      expect(sanitizeToolCallId("call_abc|item:456")).toBe("call_abc_item_456");
    });
    it("returns default for empty IDs", () => {
      expect(sanitizeToolCallId("")).toBe("default_tool_id");
    });
  });

  describe("strict mode (for Mistral/OpenRouter)", () => {
    it("strips all non-alphanumeric characters", () => {
      expect(sanitizeToolCallId("call_abc-123", "strict")).toBe("callabc123");
      expect(sanitizeToolCallId("call_abc|item:456", "strict")).toBe("callabcitem456");
      expect(sanitizeToolCallId("whatsapp_login_1768799841527_1", "strict")).toBe(
        "whatsapplogin17687998415271",
      );
    });
    it("returns default for empty IDs", () => {
      expect(sanitizeToolCallId("", "strict")).toBe("defaulttoolid");
    });
  });
});
