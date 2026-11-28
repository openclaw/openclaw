import { describe, expect, it } from "vitest";
import { buildHarnessHostRequester } from "./host-requester.js";

describe("buildHarnessHostRequester", () => {
  it("carries the verified requester device beside the sender facts", () => {
    expect(
      buildHarnessHostRequester({
        messageChannel: "webchat",
        senderId: "openclaw-ios",
        senderIsOwner: false,
        approvalReviewerDeviceId: "device-1",
      }),
    ).toEqual({
      channel: "webchat",
      senderId: "openclaw-ios",
      senderIsOwner: false,
      deviceId: "device-1",
    });
    expect(buildHarnessHostRequester({ senderId: "openclaw-ios" })).toEqual({
      senderId: "openclaw-ios",
    });
  });
});
