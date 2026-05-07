import { describe, expect, it, vi } from "vitest";
import { qqbotPlugin } from "./channel.js";

vi.mock("./bridge/gateway.js", () => ({}));
vi.mock("./engine/messaging/outbound.js", () => ({
  sendText: vi.fn(),
  sendMedia: vi.fn(),
}));

describe("qqbot messaging target parsing", () => {
  it("registers a channel-local explicit target parser", () => {
    expect(
      qqbotPlugin.messaging?.parseExplicitTarget?.({
        raw: "qqbot:c2c:A2B91CCEA0E039905B45C84DD96C92FD",
      }),
    ).toEqual({
      to: "c2c:A2B91CCEA0E039905B45C84DD96C92FD",
      chatType: "direct",
    });
  });

  it("leaves foreign provider-prefixed targets for shared provider validation", () => {
    expect(
      qqbotPlugin.messaging?.parseExplicitTarget?.({
        raw: "telegram:1234567890",
      }),
    ).toBeNull();
  });
});
