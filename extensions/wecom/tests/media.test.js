/**
 * Tests for media helpers (wecom/media.js)
 * Focuses on pure functions: guessMimeType, detectMagic (via smartDecrypt),
 * and the SSRF guard in assertSafeMediaUrl (exercised indirectly through
 * downloadAndDecryptImage / downloadWecomFile error paths).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { guessMimeType, downloadAndDecryptImage, downloadWecomFile } from "../wecom/media.js";

// ── guessMimeType ─────────────────────────────────────────────────────────────

describe("guessMimeType — known extensions", () => {
  const cases = [
    ["report.pdf", "application/pdf"],
    ["document.doc", "application/msword"],
    ["spreadsheet.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["presentation.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
    ["notes.txt", "text/plain"],
    ["data.csv", "text/csv"],
    ["archive.zip", "application/zip"],
    ["photo.png", "image/png"],
    ["photo.jpg", "image/jpeg"],
    ["photo.jpeg", "image/jpeg"],
    ["animation.gif", "image/gif"],
    ["video.mp4", "video/mp4"],
    ["audio.mp3", "audio/mpeg"],
    ["table.xls", "application/vnd.ms-excel"],
    ["slides.ppt", "application/vnd.ms-powerpoint"],
    ["word.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ];

  for (const [filename, expectedMime] of cases) {
    it(`${filename} → ${expectedMime}`, () => {
      assert.equal(guessMimeType(filename), expectedMime);
    });
  }
});

describe("guessMimeType — edge cases", () => {
  it("returns application/octet-stream for unknown extension", () => {
    assert.equal(guessMimeType("file.xyz123"), "application/octet-stream");
  });

  it("returns application/octet-stream for no extension", () => {
    assert.equal(guessMimeType("filename"), "application/octet-stream");
  });

  it("handles null/undefined gracefully", () => {
    assert.equal(guessMimeType(null), "application/octet-stream");
    assert.equal(guessMimeType(undefined), "application/octet-stream");
    assert.equal(guessMimeType(""), "application/octet-stream");
  });

  it("extension matching is case-insensitive", () => {
    assert.equal(guessMimeType("FILE.PDF"), "application/pdf");
    assert.equal(guessMimeType("photo.JPG"), "image/jpeg");
    assert.equal(guessMimeType("image.PNG"), "image/png");
  });

  it("uses the last extension component for dotted filenames", () => {
    // "report.2024.pdf" — last token after '.' is "pdf"
    assert.equal(guessMimeType("report.2024.pdf"), "application/pdf");
  });
});

// ── SSRF guard (exercised via download functions) ─────────────────────────────

describe("downloadAndDecryptImage — SSRF guard", () => {
  it("rejects file:// URLs", async () => {
    await assert.rejects(
      () => downloadAndDecryptImage("file:///etc/passwd", "key", "token"),
      /Media URL must use HTTP/,
    );
  });

  it("rejects javascript: URLs", async () => {
    await assert.rejects(
      () => downloadAndDecryptImage("javascript:alert(1)", "key", "token"),
      /Invalid media URL|Media URL must use HTTP/,
    );
  });

  it("rejects completely invalid URLs", async () => {
    await assert.rejects(
      () => downloadAndDecryptImage("not-a-url", "key", "token"),
      /Invalid media URL/,
    );
  });
});

describe("downloadWecomFile — SSRF guard", () => {
  it("rejects file:// URLs", async () => {
    await assert.rejects(
      () => downloadWecomFile("file:///etc/passwd", "file.pdf", "key", "token"),
      /Media URL must use HTTP/,
    );
  });

  it("rejects ftp:// URLs", async () => {
    await assert.rejects(
      () => downloadWecomFile("ftp://evil.com/file.pdf", "file.pdf", "key", "token"),
      /Media URL must use HTTP/,
    );
  });
});
