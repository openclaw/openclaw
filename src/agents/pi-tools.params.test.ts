import { describe, expect, it, vi } from "vitest";
import {
  assertRequiredParams,
  REQUIRED_PARAM_GROUPS,
  getToolParamsRecord,
  wrapToolParamValidation,
} from "./pi-tools.params.js";

describe("assertRequiredParams", () => {
  it("returns object params unchanged", () => {
    const params = { path: "test.txt" };
    expect(getToolParamsRecord(params)).toBe(params);
  });

  it("includes received keys in error when some params are present but content is missing", () => {
    expect(() =>
      assertRequiredParams(
        { path: "test.txt" },
        [
          { keys: ["path"], label: "path" },
          { keys: ["content"], label: "content" },
        ],
        "write",
      ),
    ).toThrow(/\(received: path\)/);
  });

  it("does not normalize legacy aliases during validation", async () => {
    const tool = wrapToolParamValidation(
      {
        name: "write",
        label: "write",
        description: "write a file",
        parameters: {},
        execute: vi.fn(),
      },
      REQUIRED_PARAM_GROUPS.write,
    );
    await expect(
      tool.execute("id", { file_path: "test.txt" }, new AbortController().signal, vi.fn()),
    ).rejects.toThrow(/\(received: file_path\)/);
  });

  it("excludes null and undefined values from received hint", () => {
    expect(() =>
      assertRequiredParams(
        { path: "test.txt", content: null },
        [
          { keys: ["path"], label: "path" },
          { keys: ["content"], label: "content" },
        ],
        "write",
      ),
    ).toThrow(/\(received: path\)[^,]/);
  });

  it("shows empty-string values for present params that still fail validation", () => {
    expect(() =>
      assertRequiredParams(
        { path: "/tmp/a.txt", content: "   " },
        [
          { keys: ["path"], label: "path" },
          { keys: ["content"], label: "content" },
        ],
        "write",
      ),
    ).toThrow(/\(received: path, content=<empty-string>\)/);
  });

  it("shows wrong-type values for present params that still fail validation", async () => {
    const tool = wrapToolParamValidation(
      {
        name: "write",
        label: "write",
        description: "write a file",
        parameters: {},
        execute: vi.fn(),
      },
      REQUIRED_PARAM_GROUPS.write,
    );
    await expect(
      tool.execute(
        "id",
        { path: "test.txt", content: { unexpected: true } },
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
          { keys: ["path"], label: "path" },
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
          { keys: ["path"], label: "path" },
          { keys: ["content"], label: "content" },
        ],
        "write",
      ),
    ).not.toThrow();
  });
});
