import { describe, expect, it } from "vitest";
import { stripFeishuReactionSuffix } from "./message-id.js";

describe("stripFeishuReactionSuffix", () => {
  it("strips :reaction:EMOJI:uuid suffix", () => {
    expect(
      stripFeishuReactionSuffix(
        "om_x100b55b75bbd1ca4c3647ec6a73d3a3:reaction:THUMBSUP:350dd4ec-46af-41c9-affc-a68cd11a5e49",
      ),
    ).toBe("om_x100b55b75bbd1ca4c3647ec6a73d3a3");
  });

  it("strips other emoji types", () => {
    expect(
      stripFeishuReactionSuffix(
        "om_abc123:reaction:HEART:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      ),
    ).toBe("om_abc123");
  });

  it("preserves clean message IDs", () => {
    expect(stripFeishuReactionSuffix("om_x100b55b75bbd1ca4c3647ec6a73d3a3")).toBe(
      "om_x100b55b75bbd1ca4c3647ec6a73d3a3",
    );
  });

  it("handles empty string", () => {
    expect(stripFeishuReactionSuffix("")).toBe("");
  });

  it("handles whitespace-only string", () => {
    expect(stripFeishuReactionSuffix("   ")).toBe("");
  });

  it("trims whitespace from message IDs", () => {
    expect(stripFeishuReactionSuffix("  om_abc123  ")).toBe("om_abc123");
  });

  it("trims whitespace and strips suffix", () => {
    expect(
      stripFeishuReactionSuffix(
        " om_abc123:reaction:SMILE:11111111-2222-3333-4444-555555555555 ",
      ),
    ).toBe("om_abc123");
  });

  it("does not strip partial matches", () => {
    // Only one colon segment — not a valid reaction suffix
    expect(stripFeishuReactionSuffix("om_abc123:reaction")).toBe("om_abc123:reaction");
  });
});
