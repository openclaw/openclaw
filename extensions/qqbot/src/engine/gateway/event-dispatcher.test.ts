import { describe, expect, it, vi } from "vitest";
import { MSG_TYPE_QUOTE } from "../utils/text-parsing.js";
import { GatewayEvent } from "./constants.js";
import { dispatchEvent } from "./event-dispatcher.js";

vi.mock("../session/known-users.js", () => ({
  recordKnownUser: vi.fn(),
}));

function expectMessageResult(result: ReturnType<typeof dispatchEvent>) {
  expect(result.action).toBe("message");
  if (result.action !== "message") {
    throw new Error(`expected message dispatch, got ${result.action}`);
  }
  return result.msg;
}

describe("engine/gateway/event-dispatcher", () => {
  it("uses C2C msg_elements attachments when the top-level attachments field is absent", () => {
    const msg = expectMessageResult(
      dispatchEvent(
        GatewayEvent.C2C_MESSAGE_CREATE,
        {
          id: "msg-1",
          content: "look",
          timestamp: "2026-05-02T00:00:00.000Z",
          author: { user_openid: "user-1" },
          message_type: 7,
          msg_elements: [
            {
              attachments: [
                {
                  content_type: "image/jpeg",
                  url: "//cdn.example.test/rainbow.jpg",
                  filename: "rainbow.jpg",
                  width: 1024,
                  height: 768,
                },
              ],
            },
          ],
        },
        "qq-main",
      ),
    );

    expect(msg.type).toBe("c2c");
    expect(msg.attachments).toEqual([
      expect.objectContaining({
        content_type: "image/jpeg",
        url: "//cdn.example.test/rainbow.jpg",
        filename: "rainbow.jpg",
      }),
    ]);
  });

  it("does not treat quoted C2C msg_elements attachments as current-message attachments", () => {
    const msg = expectMessageResult(
      dispatchEvent(
        GatewayEvent.C2C_MESSAGE_CREATE,
        {
          id: "msg-2",
          content: "replying",
          timestamp: "2026-05-02T00:00:00.000Z",
          author: { user_openid: "user-1" },
          message_type: MSG_TYPE_QUOTE,
          msg_elements: [
            {
              msg_idx: "quoted-msg",
              attachments: [
                {
                  content_type: "image/png",
                  url: "https://cdn.example.test/quoted.png",
                  filename: "quoted.png",
                },
              ],
            },
          ],
        },
        "qq-main",
      ),
    );

    expect(msg.refMsgIdx).toBe("quoted-msg");
    expect(msg.attachments).toBeUndefined();
    expect(msg.msgElements?.[0]?.attachments).toHaveLength(1);
  });
});
