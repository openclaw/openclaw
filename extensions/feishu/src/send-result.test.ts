import { describe, expect, it } from "vitest";
import { assertFeishuMessageApiSuccess } from "./send-result.js";

describe("assertFeishuMessageApiSuccess", () => {
  it("adds a clear hint for explicit cross-app open_id errors", () => {
    expect(() =>
      assertFeishuMessageApiSuccess(
        { code: 400, msg: "cross app open_id is invalid" },
        "Feishu send failed",
        { receiveIdType: "open_id" },
      ),
    ).toThrow("open_id belongs to a different Feishu app/account");
  });

  it("adds a cross-app hint when open_id delivery returns invalid user_id", () => {
    expect(() =>
      assertFeishuMessageApiSuccess({ code: 400, msg: "invalid user_id" }, "Feishu send failed", {
        receiveIdType: "open_id",
      }),
    ).toThrow("open_id belongs to a different Feishu app/account");
  });

  it("keeps invalid user_id generic for non-open_id targets", () => {
    let thrown: unknown;
    try {
      assertFeishuMessageApiSuccess({ code: 400, msg: "invalid user_id" }, "Feishu send failed", {
        receiveIdType: "chat_id",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("Feishu send failed: invalid user_id");
  });
});
