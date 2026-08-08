import { describe, expect, it } from "vitest";
import { formatSlackFileReference, formatSlackFileReferenceList } from "./file-reference.js";

describe("formatSlackFileReference", () => {
  it("includes the filename, MIME type, exact byte size, and Slack file ID", () => {
    expect(
      formatSlackFileReference({
        id: "F123",
        name: "report.pdf",
        mimetype: "application/pdf",
        size: 45_056,
      }),
    ).toBe("report.pdf (application/pdf, 45056 bytes, fileId: F123)");
  });

  it("preserves the existing placeholder when optional metadata is unavailable", () => {
    expect(formatSlackFileReference({ id: "F123", name: "report.pdf" })).toBe(
      "report.pdf (fileId: F123)",
    );
  });

  it("retains metadata for an empty uploaded file", () => {
    expect(
      formatSlackFileReference({
        id: "FEMPTY",
        name: "empty.txt",
        mimetype: "text/plain",
        size: 0,
      }),
    ).toBe("empty.txt (text/plain, 0 bytes, fileId: FEMPTY)");
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "omits an invalid Slack file size (%s)",
    (size) => {
      expect(
        formatSlackFileReference({
          id: "F123",
          name: "report.pdf",
          mimetype: "application/pdf",
          size,
        }),
      ).toBe("report.pdf (application/pdf, fileId: F123)");
    },
  );

  it("omits empty MIME metadata without changing the existing placeholder", () => {
    expect(formatSlackFileReference({ id: "F123", name: "report.pdf", mimetype: "  " })).toBe(
      "report.pdf (fileId: F123)",
    );
  });
});

describe("formatSlackFileReferenceList", () => {
  it("retains each attachment's own filename, MIME type, size, and file ID", () => {
    expect(
      formatSlackFileReferenceList([
        { id: "FA", name: "a.jpg", mimetype: "image/jpeg", size: 12 },
        { id: "FB", name: "b.png", mimetype: "image/png", size: 34 },
      ]),
    ).toBe("a.jpg (image/jpeg, 12 bytes, fileId: FA), b.png (image/png, 34 bytes, fileId: FB)");
  });

  it("preserves the fallback for missing file lists", () => {
    expect(formatSlackFileReferenceList(undefined)).toBe("file");
    expect(formatSlackFileReferenceList([])).toBe("file");
  });
});
