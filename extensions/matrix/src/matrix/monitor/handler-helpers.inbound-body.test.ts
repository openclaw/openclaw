import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { resolveMatrixInboundBodyText } from "./handler-helpers.js";

describe("resolveMatrixInboundBodyText", () => {
  it("uses the resolved placeholder for an explicit filename", () => {
    assert.equal(
      resolveMatrixInboundBodyText({
        rawBody: "clip.webm",
        filename: "clip.webm",
        msgtype: "m.video",
        mediaPlaceholder: "<media:video>",
        hadMediaUrl: true,
        mediaDownloadFailed: false,
      }),
      "<media:video>",
    );
  });
  it("preserves a genuine caption", () => {
    assert.equal(
      resolveMatrixInboundBodyText({
        rawBody: "Watch this clip",
        filename: "clip.webm",
        msgtype: "m.video",
        mediaPlaceholder: "<media:video>",
        hadMediaUrl: true,
        mediaDownloadFailed: false,
      }),
      "Watch this clip",
    );
  });
});
