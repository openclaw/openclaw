import { describe, expect, it } from "vitest";
import { normalizeFeishuOpenMessageId } from "./message-id.js";

describe("normalizeFeishuOpenMessageId", () => {
  it("keeps already-normalized message ids unchanged", () => {
    expect(normalizeFeishuOpenMessageId("om_message")).toBe("om_message");
  });

  it("trims whitespace around already-normalized message ids", () => {
    expect(normalizeFeishuOpenMessageId("  om_message  ")).toBe("om_message");
  });

  it("strips synthetic reaction suffixes", () => {
    expect(normalizeFeishuOpenMessageId("om_message:reaction:THUMBSUP:uuid-1")).toBe("om_message");
  });
});
