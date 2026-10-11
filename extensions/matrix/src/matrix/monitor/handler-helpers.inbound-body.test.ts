import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { resolveMatrixInboundBodyText } from "./handler-helpers.js";

describe("resolveMatrixInboundBodyText", () => {
  for (const { msgtype, filename, placeholder } of [
    { msgtype: "m.audio", filename: "recording.ogg", placeholder: "<media:audio>" },
    { msgtype: "m.file", filename: "report.pdf", placeholder: "<media:document>" },
    { msgtype: "m.image", filename: "photo.png", placeholder: "<media:image>" },
    { msgtype: "m.video", filename: "clip.webm", placeholder: "<media:video>" },
  ]) {
    it(`uses the resolved placeholder for an explicit ${msgtype} filename`, () => {
      assert.equal(
        resolveMatrixInboundBodyText({
          rawBody: filename,
          filename,
          msgtype,
          mediaPlaceholder: placeholder,
          hadMediaUrl: true,
          mediaDownloadFailed: false,
        }),
        placeholder,
      );
    });
  }

  it("recognizes an explicit filename without a suffix after whitespace normalization", () => {
    assert.equal(
      resolveMatrixInboundBodyText({
        rawBody: "upload",
        filename: " upload ",
        msgtype: "m.file",
        mediaPlaceholder: "<media:document>",
        hadMediaUrl: true,
        mediaDownloadFailed: false,
      }),
      "<media:document>",
    );
  });

  for (const rawBody of ["Watch this clip", "release.v2", "  release.v2  "]) {
    it(`preserves the genuine caption ${JSON.stringify(rawBody)}`, () => {
      assert.equal(
        resolveMatrixInboundBodyText({
          rawBody,
          filename: "clip.webm",
          msgtype: "m.video",
          mediaPlaceholder: "<media:video>",
          hadMediaUrl: true,
          mediaDownloadFailed: false,
        }),
        rawBody,
      );
    });
  }

  for (const filename of [undefined, "", " \t "]) {
    it(`keeps body text without an explicit filename (${JSON.stringify(filename)})`, () => {
      assert.equal(
        resolveMatrixInboundBodyText({
          rawBody: "clip.webm",
          filename,
          msgtype: "m.video",
          mediaPlaceholder: "<media:video>",
          hadMediaUrl: true,
          mediaDownloadFailed: false,
        }),
        "clip.webm",
      );
    });
  }

  it("keeps a non-media body even when filename matches it", () => {
    assert.equal(
      resolveMatrixInboundBodyText({
        rawBody: "message.txt",
        filename: "message.txt",
        msgtype: "m.text",
        mediaPlaceholder: "<media:document>",
        hadMediaUrl: true,
        mediaDownloadFailed: false,
      }),
      "message.txt",
    );
  });

  it("keeps the resolved placeholder when the body is empty", () => {
    assert.equal(
      resolveMatrixInboundBodyText({
        rawBody: "",
        filename: "clip.webm",
        msgtype: "m.video",
        mediaPlaceholder: "<media:video>",
        hadMediaUrl: true,
        mediaDownloadFailed: false,
      }),
      "<media:video>",
    );
  });
});
