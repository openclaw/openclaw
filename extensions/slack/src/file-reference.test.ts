import { describe, expect, it } from "vitest";
import { formatSlackFileReference, formatSlackFileReferenceList } from "./file-reference.js";

describe("formatSlackFileReference", () => {
  it("includes Slack file id, MIME type, and exact byte size when available", () => {
    expect(
      formatSlackFileReference({
        id: "F123",
        name: "report.pdf",
        mimetype: "application/pdf",
        size: 45056,
      }),
    ).toBe("report.pdf (application/pdf, 45056 bytes, fileId: F123)");
  });

  it("preserves the previous compact shape when Slack omits MIME type and size", () => {
    expect(formatSlackFileReference({ id: "F123", name: "report.pdf" })).toBe(
      "report.pdf (fileId: F123)",
    );
  });

  it("omits malformed optional metadata", () => {
    expect(
      formatSlackFileReference({
        id: "F123",
        name: "report.pdf",
        mimetype: "  ",
        size: -1,
      }),
    ).toBe("report.pdf (fileId: F123)");
  });
});

describe("formatSlackFileReferenceList", () => {
  it("formats each file with its own metadata", () => {
    expect(
      formatSlackFileReferenceList([
        { id: "FA", name: "a.jpg", mimetype: "image/jpeg", size: 12 },
        { id: "FB", name: "b.png", mimetype: "image/png", size: 34 },
      ]),
    ).toBe("a.jpg (image/jpeg, 12 bytes, fileId: FA), b.png (image/png, 34 bytes, fileId: FB)");
  });
});
