import { describe, expect, it } from "vitest";
import { assertFeishuMessageApiSuccess } from "./send-result.js";

describe("assertFeishuMessageApiSuccess", () => {
  it("does not throw when code is 0", () => {
    expect(() => {
      assertFeishuMessageApiSuccess({ code: 0, msg: "ok" }, "test");
    }).not.toThrow();
  });

  it("does not throw when code is undefined (SDK v1.30+ success)", () => {
    expect(() => {
      assertFeishuMessageApiSuccess({ msg: "ok", data: { message_id: "m1" } }, "test");
    }).not.toThrow();
  });

  it("throws when code is non-zero", () => {
    expect(() => {
      assertFeishuMessageApiSuccess({ code: 99991663, msg: "token expired" }, "test");
    }).toThrow("test: token expired");
  });

  it("throws with code fallback when msg is empty", () => {
    expect(() => {
      assertFeishuMessageApiSuccess({ code: 400 }, "test");
    }).toThrow("test: code 400");
  });
});
