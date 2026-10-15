// OC Path tests cover oc path plugin behavior.
import { describe, expect, it } from "vitest";
import { OcPathError, formatOcPath, parseOcPath } from "../oc-path.js";

describe("parseOcPath", () => {
  it("parses session query", () => {
    expect(parseOcPath("oc://SOUL.md?session=daily-cron")).toEqual({
      file: "SOUL.md",
      session: "daily-cron",
    });
  });

  it("rejects control chars in session query values", () => {
    expectOcPathError(
      () => parseOcPath("oc://SOUL.md?session=daily\x00cron"),
      "OC_PATH_CONTROL_CHAR",
    );
  });

  it("rejects missing scheme", () => {
    expectOcPathError(() => parseOcPath("SOUL.md"), "OC_PATH_MISSING_SCHEME");
  });

  it("rejects empty path after scheme", () => {
    expectOcPathError(() => parseOcPath("oc://"), "OC_PATH_EMPTY");
  });

  it("rejects empty segment", () => {
    expectOcPathError(() => parseOcPath("oc://SOUL.md//deny-rule-1"), "OC_PATH_EMPTY_SEGMENT");
  });

  it("rejects too-deep nesting", () => {
    expectOcPathError(() => parseOcPath("oc://SOUL.md/a/b/c/d/e"), "OC_PATH_TOO_DEEP");
  });

  it("rejects non-string input", () => {
    expectOcPathError(() => parseOcPath(123 as unknown as string), "OC_PATH_NOT_STRING");
  });
});

function expectOcPathError(fn: () => unknown, expectedCode: string): void {
  try {
    fn();
    expect.fail(`expected OcPathError with code "${expectedCode}" but no error thrown`);
  } catch (err) {
    expect(err).toBeInstanceOf(OcPathError);
    expect((err as OcPathError).code).toBe(expectedCode);
  }
}

describe("formatOcPath", () => {
  it("rejects reserved chars in formatted session values", () => {
    expectOcPathError(
      () => formatOcPath({ file: "SOUL.md", session: "cron&scope=daily" }),
      "OC_PATH_RESERVED_CHAR",
    );
  });

  it("rejects empty file", () => {
    expectOcPathError(() => formatOcPath({ file: "" }), "OC_PATH_FILE_REQUIRED");
  });

  it("rejects item without section", () => {
    expectOcPathError(() => formatOcPath({ file: "F.md", item: "i" }), "OC_PATH_NESTING");
  });
});
