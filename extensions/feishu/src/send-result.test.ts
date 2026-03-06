import { describe, expect, it } from "vitest";
import { assertFeishuMessageApiSuccess } from "./send-result.js";

describe("assertFeishuMessageApiSuccess", () => {
  it("does not throw when code is 0", () => {
    expect(() => {
      assertFeishuMessageApiSuccess({ code: 0 }, "test");
    }).not.toThrow();
  });

  it("does not throw when code is undefined (SDK v1.30+ success)", () => {
    expect(() => {
      assertFeishuMessageApiSuccess({}, "test");
    }).not.toThrow();
  });

  it("throws when code is a non-zero number", () => {
    expect(() => {
      assertFeishuMessageApiSuccess({ code: 99991, msg: "invalid token" }, "Feishu send failed");
    }).toThrow("Feishu send failed: invalid token");
  });

  it("throws with code fallback when msg is empty", () => {
    expect(() => {
      assertFeishuMessageApiSuccess({ code: 40003 }, "Feishu send failed");
    }).toThrow("Feishu send failed: code 40003");
  });
});
