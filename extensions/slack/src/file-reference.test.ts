import { describe, expect, it } from "vitest";
import { formatSlackFileReference, formatSlackFileReferenceList } from "./file-reference.js";
import type { SlackFile } from "./types.js";

describe("formatSlackFileReference", () => {
  it("falls back to 'file' when the SlackFile is undefined", () => {
    expect(formatSlackFileReference(undefined)).toBe("file");
  });

  it("falls back to 'file' when name and id are both missing", () => {
    expect(formatSlackFileReference({})).toBe("file");
  });

  it("returns the name alone when fileId is missing", () => {
    const file: SlackFile = { name: "report.pdf" };
    expect(formatSlackFileReference(file)).toBe("report.pdf");
  });

  it("returns 'file (fileId: ...)' when only id is present", () => {
    const file: SlackFile = { id: "F09ABC123" };
    expect(formatSlackFileReference(file)).toBe("file (fileId: F09ABC123)");
  });

  it("returns 'name (fileId: ...)' when both name and id are present", () => {
    const file: SlackFile = { name: "design.sketch", id: "F09ABC123" };
    expect(formatSlackFileReference(file)).toBe("design.sketch (fileId: F09ABC123)");
  });

  it("treats whitespace-only name as missing and falls back to 'file'", () => {
    const file: SlackFile = { name: "   ", id: "F09XYZ" };
    expect(formatSlackFileReference(file)).toBe("file (fileId: F09XYZ)");
  });
});

describe("formatSlackFileReferenceList", () => {
  it("falls back to 'file' for an undefined files list", () => {
    expect(formatSlackFileReferenceList(undefined)).toBe("file");
  });

  it("falls back to 'file' for an empty files list", () => {
    expect(formatSlackFileReferenceList([])).toBe("file");
  });

  it("formats a single file via formatSlackFileReference", () => {
    const files: SlackFile[] = [{ name: "only.png", id: "F1" }];
    expect(formatSlackFileReferenceList(files)).toBe("only.png (fileId: F1)");
  });

  it("joins multiple files with ', ' and preserves per-file fallbacks", () => {
    const files: SlackFile[] = [
      { name: "first.txt", id: "F1" },
      { id: "F2" },
      { name: "third.png" },
    ];
    expect(formatSlackFileReferenceList(files)).toBe(
      "first.txt (fileId: F1), file (fileId: F2), third.png",
    );
  });
});
