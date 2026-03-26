import { describe, expect, it } from "vitest";
import { __testing } from "./pi-tools.js";

const { assertRequiredParams } = __testing;

describe("assertRequiredParams", () => {
  it("includes received keys in error when some params are present but content is missing", () => {
    expect(() =>
      assertRequiredParams(
        { file_path: "test.txt" },
        [
          { keys: ["path", "file_path"], label: "path alias" },
          { keys: ["content"], label: "content" },
        ],
        "write",
      ),
    ).toThrow(/\(received: file_path\)/);
  });

  it("includes multiple received keys when several params are present", () => {
    expect(() =>
      assertRequiredParams(
        { path: "/tmp/a.txt", extra: "yes" },
        [
          { keys: ["path", "file_path"], label: "path alias" },
          { keys: ["content"], label: "content" },
        ],
        "write",
      ),
    ).toThrow(/\(received: path, extra\)/);
  });

  it("omits received hint when the record is empty", () => {
    const err = (() => {
      try {
        assertRequiredParams({}, [{ keys: ["content"], label: "content" }], "write");
      } catch (e) {
        return e instanceof Error ? e.message : "";
      }
      return "";
    })();
    expect(err).not.toMatch(/received:/);
    expect(err).toMatch(/Missing required parameter: content/);
  });

  it("does not throw when all required params are present", () => {
    expect(() =>
      assertRequiredParams(
        { path: "a.txt", content: "hello" },
        [
          { keys: ["path", "file_path"], label: "path alias" },
          { keys: ["content"], label: "content" },
        ],
        "write",
      ),
    ).not.toThrow();
  });
});
