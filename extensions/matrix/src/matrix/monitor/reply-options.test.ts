import { describe, expect, it } from "vitest";
import { resolveMatrixReplyOptions } from "./reply-options.js";

describe("resolveMatrixReplyOptions", () => {
  it("uses global reply options for DMs", () => {
    expect(
      resolveMatrixReplyOptions({
        isRoom: false,
        globalReplyToMode: "off",
        globalThreadReplies: "inbound",
      }),
    ).toEqual({ replyToMode: "off", threadReplies: "inbound" });
  });

  it("uses global reply options when room has no overrides", () => {
    expect(
      resolveMatrixReplyOptions({
        isRoom: true,
        roomConfig: { allow: true },
        globalReplyToMode: "off",
        globalThreadReplies: "inbound",
      }),
    ).toEqual({ replyToMode: "off", threadReplies: "inbound" });
  });

  it("applies room-specific reply options for groups", () => {
    expect(
      resolveMatrixReplyOptions({
        isRoom: true,
        roomConfig: { allow: true, replyToMode: "first", threadReplies: "always" },
        globalReplyToMode: "off",
        globalThreadReplies: "inbound",
      }),
    ).toEqual({ replyToMode: "first", threadReplies: "always" });
  });
});
