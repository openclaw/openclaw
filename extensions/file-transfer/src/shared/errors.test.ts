// File Transfer tests cover errors plugin behavior.
import { describe, expect, it } from "vitest";
import { err, throwFromNodePayload } from "./errors.js";

describe("err", () => {
  it("returns an error envelope without canonicalPath when omitted", () => {
    const e = err("INVALID_PATH", "path required");
    expect(e).toEqual({ ok: false, code: "INVALID_PATH", message: "path required" });
    expect("canonicalPath" in e).toBe(false);
  });

  it("includes canonicalPath only when provided non-empty", () => {
    const withPath = err("NOT_FOUND", "missing", "/tmp/x");
    expect(withPath.canonicalPath).toBe("/tmp/x");

    const blankPath = err("NOT_FOUND", "missing", "");
    expect("canonicalPath" in blankPath).toBe(false);
  });
});

describe("throwFromNodePayload", () => {
  it("preserves code and message in the thrown Error", () => {
    expect(() =>
      throwFromNodePayload("file.fetch", { code: "NOT_FOUND", message: "file not found" }),
    ).toThrow(/file\.fetch NOT_FOUND: file not found/);
  });

  it("appends canonicalPath when present", () => {
    expect(() =>
      throwFromNodePayload("file.fetch", {
        code: "POLICY_DENIED",
        message: "blocked",
        canonicalPath: "/tmp/x",
      }),
    ).toThrow(/canonical=\/tmp\/x/);
  });

  it("falls back to ERROR / generic message when fields are missing", () => {
    expect(() => throwFromNodePayload("dir.list", {})).toThrow(/dir\.list ERROR: dir\.list failed/);
  });
});
