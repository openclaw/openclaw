import { describe, expect, it } from "vitest";
import { resolveMatrixBodyForAgent, resolveMatrixInboundSenderLabel } from "./inbound-body.js";

describe("resolveMatrixInboundSenderLabel", () => {
  it("includes sender username when it differs from display name", () => {
    expect(
      resolveMatrixInboundSenderLabel({
        senderName: "Bu",
        senderId: "@bu:matrix.example.org",
      }),
    ).toBe("Bu (bu)");
  });

  it("falls back to sender username when display name is blank", () => {
    expect(
      resolveMatrixInboundSenderLabel({
        senderName: " ",
        senderId: "@zhang:matrix.example.org",
      }),
    ).toBe("zhang");
  });

  it("falls back to sender id when username cannot be parsed", () => {
    expect(
      resolveMatrixInboundSenderLabel({
        senderName: "",
        senderId: "matrix-user-without-colon",
      }),
    ).toBe("matrix-user-without-colon");
  });
});

describe("resolveMatrixBodyForAgent", () => {
  it("keeps direct message body unchanged", () => {
    expect(
      resolveMatrixBodyForAgent({
        isDirectMessage: true,
        bodyText: "show me my commits",
        senderName: "Bu",
        senderId: "@bu:matrix.example.org",
      }),
    ).toBe("show me my commits");
  });

  it("prefixes non-direct message body with sender label", () => {
    expect(
      resolveMatrixBodyForAgent({
        isDirectMessage: false,
        bodyText: "show me my commits",
        senderName: "Bu",
        senderId: "@bu:matrix.example.org",
      }),
    ).toBe("Bu (bu): show me my commits");
  });
});
