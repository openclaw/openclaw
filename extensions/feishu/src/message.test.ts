import { describe, it, expect, beforeEach, vi } from "vitest";
import { FeishuMessageSchema } from "./message-schema.js";

describe("FeishuMessageSchema", () => {
  it("should validate list action with chat_id", () => {
    const result = FeishuMessageSchema.parse({
      action: "list",
      chat_id: "oc_123456",
    });
    expect(result.action).toBe("list");
    expect(result.chat_id).toBe("oc_123456");
    expect(result.page_size).toBe(20); // default
  });

  it("should validate recall action with message_id", () => {
    const result = FeishuMessageSchema.parse({
      action: "recall",
      chat_id: "oc_123456",
      message_id: "om_789012",
    });
    expect(result.action).toBe("recall");
    expect(result.message_id).toBe("om_789012");
  });

  it("should validate delete action with message_id", () => {
    const result = FeishuMessageSchema.parse({
      action: "delete",
      chat_id: "oc_123456",
      message_id: "om_789012",
    });
    expect(result.action).toBe("delete");
  });

  it("should validate optional time range for list (Unix timestamps)", () => {
    const result = FeishuMessageSchema.parse({
      action: "list",
      chat_id: "oc_123456",
      start_time: "1609296809",
      end_time: "1609383209",
    });
    expect(result.start_time).toBe("1609296809");
    expect(result.end_time).toBe("1609383209");
  });

  it("should validate page_size within range", () => {
    const result1 = FeishuMessageSchema.parse({
      action: "list",
      chat_id: "oc_123456",
      page_size: 1,
    });
    expect(result1.page_size).toBe(1);

    const result2 = FeishuMessageSchema.parse({
      action: "list",
      chat_id: "oc_123456",
      page_size: 50,
    });
    expect(result2.page_size).toBe(50);
  });

  it("should reject page_size out of range", () => {
    expect(() =>
      FeishuMessageSchema.parse({
        action: "list",
        chat_id: "oc_123456",
        page_size: 0,
      }),
    ).toThrow();

    expect(() =>
      FeishuMessageSchema.parse({
        action: "list",
        chat_id: "oc_123456",
        page_size: 100,
      }),
    ).toThrow();
  });

  it("should reject invalid action", () => {
    expect(() =>
      FeishuMessageSchema.parse({
        action: "invalid",
        chat_id: "oc_123456",
      }),
    ).toThrow();
  });

  it("should reject missing chat_id", () => {
    expect(() =>
      FeishuMessageSchema.parse({
        action: "list",
      }),
    ).toThrow();
  });
});
