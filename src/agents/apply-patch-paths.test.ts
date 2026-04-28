import { describe, expect, it } from "vitest";
import { extractApplyPatchTargetPaths } from "./apply-patch-paths.js";

describe("extractApplyPatchTargetPaths", () => {
  it("returns an empty array for non-string input", () => {
    expect(extractApplyPatchTargetPaths(undefined)).toEqual([]);
    expect(extractApplyPatchTargetPaths(null)).toEqual([]);
    expect(extractApplyPatchTargetPaths(42)).toEqual([]);
    expect(extractApplyPatchTargetPaths({})).toEqual([]);
    expect(extractApplyPatchTargetPaths({ input: 7 })).toEqual([]);
  });

  it("returns an empty array for an empty patch", () => {
    expect(extractApplyPatchTargetPaths("")).toEqual([]);
    expect(extractApplyPatchTargetPaths({ input: "" })).toEqual([]);
  });

  it("extracts Add File markers from the envelope payload", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: src/new.ts",
      "+export const a = 1;",
      "*** End Patch",
    ].join("\n");
    expect(extractApplyPatchTargetPaths(patch)).toEqual(["src/new.ts"]);
  });

  it("extracts Update File and Delete File markers", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: a.ts",
      "@@",
      " context",
      "+added",
      "*** Delete File: b.ts",
      "*** End Patch",
    ].join("\n");
    expect(extractApplyPatchTargetPaths(patch)).toEqual(["a.ts", "b.ts"]);
  });

  it("includes the Move to: target paired with an Update File", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: old/path.ts",
      "*** Move to: new/path.ts",
      "@@",
      " context",
      "+added",
      "*** End Patch",
    ].join("\n");
    expect(extractApplyPatchTargetPaths(patch)).toEqual(["old/path.ts", "new/path.ts"]);
  });

  it("tolerates blank lines between Update File and Move to", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: a.ts",
      "",
      "*** Move to: b.ts",
      "*** End Patch",
    ].join("\n");
    expect(extractApplyPatchTargetPaths(patch)).toEqual(["a.ts", "b.ts"]);
  });

  it("accepts the wrapper object form used by the apply_patch tool", () => {
    const patch = ["*** Begin Patch", "*** Add File: foo.ts", "+x", "*** End Patch"].join("\n");
    expect(extractApplyPatchTargetPaths({ input: patch })).toEqual(["foo.ts"]);
  });

  it("de-duplicates repeated paths within a single envelope", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: same.ts",
      "+a",
      "*** Update File: same.ts",
      "@@",
      "+b",
      "*** End Patch",
    ].join("\n");
    expect(extractApplyPatchTargetPaths(patch)).toEqual(["same.ts"]);
  });

  it("handles CRLF line endings", () => {
    const patch = ["*** Begin Patch", "*** Add File: crlf.ts", "+x", "*** End Patch"].join("\r\n");
    expect(extractApplyPatchTargetPaths(patch)).toEqual(["crlf.ts"]);
  });

  it("ignores markers outside of the envelope grammar", () => {
    expect(
      extractApplyPatchTargetPaths(
        ["nothing here", "*** Random Marker: x", "+a", "context"].join("\n"),
      ),
    ).toEqual([]);
  });

  it("does not require the begin/end envelope markers to be present", () => {
    const patch = ["*** Add File: loose.ts", "+x"].join("\n");
    expect(extractApplyPatchTargetPaths(patch)).toEqual(["loose.ts"]);
  });
});
