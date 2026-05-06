import { describe, expect, it } from "vitest";
import { normalizeFeishuOpenMessageId } from "./message-id.js";

describe("normalizeFeishuOpenMessageId", () => {
  it("trims synthetic reaction suffixes before Feishu API use", () => {
    expect(normalizeFeishuOpenMessageId(" om_123:reaction:+1:uuid-1 ")).toBe("om_123");
  });

  it("leaves already-normalized open message IDs unchanged", () => {
    expect(normalizeFeishuOpenMessageId(" om_123 ")).toBe("om_123");
  });
});
