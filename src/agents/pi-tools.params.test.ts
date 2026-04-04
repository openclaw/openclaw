import { describe, expect, it, vi } from "vitest";
import { __testing } from "./pi-tools.js";
import { CLAUDE_PARAM_GROUPS } from "./pi-tools.params.js";

const { assertRequiredParams, wrapToolParamNormalization } = __testing;

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

  it("shows normalized key in hint when called through wrapToolParamNormalization (file_path alias -> path)", async () => {
    const tool = wrapToolParamNormalization(
      {
        name: "write",
        label: "write",
        description: "write a file",
        parameters: {},
        execute: vi.fn(),
      },
      CLAUDE_PARAM_GROUPS.write,
    );
    await expect(
      tool.execute("id", { file_path: "test.txt" }, new AbortController().signal, vi.fn()),
    ).rejects.toThrow(/\(received: path\)/);
  });

  it("excludes null and undefined values from received hint", () => {
    expect(() =>
      assertRequiredParams(
        { file_path: "test.txt", content: null },
        [
          { keys: ["path", "file_path"], label: "path alias" },
          { keys: ["content"], label: "content" },
        ],
        "write",
      ),
    ).toThrow(/\(received: file_path\)[^,]/);
  });

  it("shows empty-string values for present params that still fail validation", () => {
    expect(() =>
      assertRequiredParams(
        { path: "/tmp/a.txt", content: "   " },
        [
          { keys: ["path", "file_path"], label: "path alias" },
          { keys: ["content"], label: "content" },
        ],
        "write",
      ),
    ).toThrow(/\(received: path, content=<empty-string>\)/);
  });

  it("shows wrong-type values for present params that still fail validation", async () => {
    const tool = wrapToolParamNormalization(
      {
        name: "write",
        label: "write",
        description: "write a file",
        parameters: {},
        execute: vi.fn(),
      },
      CLAUDE_PARAM_GROUPS.write,
    );
    await expect(
      tool.execute(
        "id",
        { file_path: "test.txt", content: { unexpected: true } },
        new AbortController().signal,
        vi.fn(),
      ),
    ).rejects.toThrow(/\(received: (?:path, content=<object>|content=<object>, path)\)/);
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
